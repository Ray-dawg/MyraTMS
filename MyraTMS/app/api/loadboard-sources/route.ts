/**
 * GET /api/loadboard-sources — admin-only.
 *
 * Lists every load board source with current ingest_method, throttling
 * config, and the linked integration's redacted display info. This is
 * what the (eventual) Settings → Integrations UI will read to render
 * the cutover dashboard.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, requireRole } from '@/lib/auth';
import { apiError } from '@/lib/api-error';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SourceListRow {
  source: string;
  ingest_method: string;
  integration_id: string | null;
  integration_provider: string | null;
  integration_enabled: boolean | null;
  poll_interval_minutes: number;
  rate_limit_per_minute: number | null;
  last_polled_at: string | null;
  notes: string | null;
  updated_at: string;
}

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req);
  if (!user) return apiError('Unauthorized', 401);
  const denied = requireRole(user, 'admin');
  if (denied) return denied;

  try {
    const r = await db.query<SourceListRow>(
      `SELECT s.source,
              s.ingest_method,
              s.integration_id,
              i.provider AS integration_provider,
              i.enabled  AS integration_enabled,
              s.poll_interval_minutes,
              s.rate_limit_per_minute,
              s.last_polled_at::text,
              s.notes,
              s.updated_at::text
         FROM loadboard_sources s
    LEFT JOIN integrations i ON i.id = s.integration_id
     ORDER BY s.source`,
    );
    return NextResponse.json({ sources: r.rows });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[loadboard-sources GET] error: ${msg}`);
    return apiError('Failed to load source registry', 500);
  }
}
