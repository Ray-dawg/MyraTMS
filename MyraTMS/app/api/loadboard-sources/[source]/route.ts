/**
 * PATCH /api/loadboard-sources/[source] — admin-only.
 *
 * The cutover endpoint. Flips a source's ingest_method between
 * 'api' / 'scrape' / 'disabled' / 'cutover' and atomically links
 * the integration row that holds API credentials.
 *
 * Body shape:
 *   {
 *     ingest_method: 'api' | 'scrape' | 'disabled' | 'cutover',
 *     integration_id?: string,   // required when ingest_method='api'
 *     notes?: string
 *   }
 *
 * Recommended cutover sequence (scrape → api):
 *   1. POST /api/integrations  to add api creds (returns integration_id)
 *   2. PATCH ingest_method='cutover'             — drains in-flight scrape
 *   3. (wait ~60-90s for any active scrape poll to finish)
 *   4. PATCH ingest_method='api', integration_id=<uuid>
 *
 * The Vercel API path picks up the change on its next minute-tick;
 * the Railway scraper picks it up within 30s (registry cache TTL).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, requireRole } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { logger } from '@/lib/logger';
import {
  setIngestMethod,
  getSource,
  type IngestMethod,
} from '@/lib/loadboards/source-registry';
import type { LoadBoardSource } from '@/lib/loadboards/base';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_METHODS: IngestMethod[] = ['api', 'scrape', 'disabled', 'cutover'];
const VALID_SOURCES: LoadBoardSource[] = ['dat', 'truckstop', '123lb', 'loadlink'];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ source: string }> },
) {
  const user = getCurrentUser(req);
  if (!user) return apiError('Unauthorized', 401);
  const denied = requireRole(user, 'admin');
  if (denied) return denied;

  const { source } = await params;
  if (!VALID_SOURCES.includes(source as LoadBoardSource)) {
    return apiError(`Unknown source: ${source}`, 400);
  }

  try {
    const row = await getSource(source as LoadBoardSource);
    if (!row) return apiError(`No registry row for source=${source}`, 404);
    return NextResponse.json({ source: row });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[loadboard-sources GET ${source}] error: ${msg}`);
    return apiError('Failed to load source', 500);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ source: string }> },
) {
  const user = getCurrentUser(req);
  if (!user) return apiError('Unauthorized', 401);
  const denied = requireRole(user, 'admin');
  if (denied) return denied;

  const { source } = await params;
  if (!VALID_SOURCES.includes(source as LoadBoardSource)) {
    return apiError(`Unknown source: ${source}`, 400);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('Invalid JSON body', 400);
  }

  const { ingest_method, integration_id, notes } = (body ?? {}) as {
    ingest_method?: IngestMethod;
    integration_id?: string | null;
    notes?: string;
  };

  if (!ingest_method || !VALID_METHODS.includes(ingest_method)) {
    return apiError(`ingest_method must be one of: ${VALID_METHODS.join(', ')}`, 400);
  }
  if (ingest_method === 'api' && !integration_id) {
    return apiError(`integration_id is required when ingest_method='api'`, 400);
  }
  if (integration_id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(integration_id)) {
    return apiError(`integration_id must be a UUID`, 400);
  }

  try {
    const updated = await setIngestMethod({
      source: source as LoadBoardSource,
      ingest_method,
      integration_id: integration_id ?? null,
      notes,
    });

    logger.info(
      `[loadboard-sources PATCH] cutover source=${source} → ${ingest_method} by user=${user.userId} role=${user.role}`,
      { integration_id: integration_id ?? null },
    );

    return NextResponse.json({ source: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[loadboard-sources PATCH ${source}] error: ${msg}`);
    // Surface validation messages to the operator (e.g. invalid transition);
    // the underlying setIngestMethod throws Error with a clear reason.
    return apiError(msg, 400);
  }
}
