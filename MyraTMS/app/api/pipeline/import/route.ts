/**
 * Pipeline import endpoint — Agent 1 (Scanner) CSV / JSON ingestion.
 *
 * POST /api/pipeline/import
 *   Body: { loads: Partial<RawLoad>[], source?: string }
 *   Auth: Authorization: Bearer ${PIPELINE_IMPORT_TOKEN || CRON_SECRET}
 *   Returns: { received, inserted, duplicates, invalid, errors[] }
 *
 * Honors PIPELINE_ENABLED — when false, returns 503 to make shadow-mode
 * deployments visible to the caller.
 *
 * The actual write + queue logic lives in ScannerService.ingestRawLoads so
 * the same path can be exercised by tests, the future cron-based scrapers,
 * and any back-fill scripts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { Queue } from 'bullmq';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { ScannerService, type RawLoad } from '@/lib/workers/scanner-worker';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let cachedService: ScannerService | null = null;
let cachedQueue: Queue | null = null;

function getService(): ScannerService {
  if (!cachedService) {
    cachedQueue = new Queue('qualify-queue', { connection: redisConnection });
    cachedService = new ScannerService(redisConnection, cachedQueue);
  }
  return cachedService;
}

function authorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? '';
  const expected = process.env.PIPELINE_IMPORT_TOKEN || process.env.CRON_SECRET;
  if (!expected) return false;
  return auth === `Bearer ${expected}`;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now();

  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (process.env.PIPELINE_ENABLED !== 'true') {
    return NextResponse.json(
      { error: 'pipeline_disabled', hint: 'Set PIPELINE_ENABLED=true' },
      { status: 503 },
    );
  }

  let body: { loads?: Array<Partial<RawLoad>>; source?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!Array.isArray(body.loads)) {
    return NextResponse.json(
      { error: 'invalid_body', hint: 'expected { loads: RawLoad[] }' },
      { status: 400 },
    );
  }

  if (body.loads.length === 0) {
    return NextResponse.json({ received: 0, inserted: 0, duplicates: 0, invalid: 0, errors: [] });
  }

  if (body.loads.length > 500) {
    return NextResponse.json(
      { error: 'too_many_loads', max: 500, received: body.loads.length },
      { status: 413 },
    );
  }

  const source = (body.source ?? 'manual') as RawLoad['loadBoardSource'];

  try {
    const result = await getService().ingestRawLoads(body.loads, source);

    logger.info('[pipeline-import] processed', {
      source,
      received: result.received,
      inserted: result.inserted,
      duplicates: result.duplicates,
      invalid: result.invalid,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    logger.error('[pipeline-import] crash', err);
    return NextResponse.json(
      { error: 'import_failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, route: 'pipeline-import' });
}
