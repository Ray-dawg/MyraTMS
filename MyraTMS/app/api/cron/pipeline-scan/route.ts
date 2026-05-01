/**
 * Cron: pipeline-scan (Sprint 6.5 — official-API ingest dispatcher)
 *
 * Fires every minute. Reads loadboard_sources for all rows in
 * ingest_method='api' state, throttles per-source by poll_interval_minutes,
 * and dispatches each due source to ScannerService.pollSourceViaAPI().
 *
 * The Vercel cron schedule is in vercel.json (`* * * * *`). All four
 * sources (DAT/Truckstop/123LB/Loadlink) currently default to non-'api'
 * states post-migration 026 — this route is therefore a no-work heartbeat
 * until the operator flips a source to 'api' (via the admin endpoint or
 * direct SQL).
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 * Kill switches: PIPELINE_ENABLED, SCANNER_ENABLED
 *
 * NOTE: This route does NOT touch sources in ingest_method='scrape' — those
 * are polled by the Railway scraper (M1/scraper/). The DB registry ensures
 * exactly one of the two services polls any given source at any moment.
 */

import { NextRequest, NextResponse } from 'next/server';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '@/lib/logger';
import { ScannerService } from '@/lib/workers/scanner-worker';
import {
  getActiveAPISources,
  isDuePoll,
  markPolled,
  type SourceRow,
} from '@/lib/loadboards/source-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? '';
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  return auth === `Bearer ${expected}`;
}

/**
 * Build a per-request scanner. Cron invocations are independent and
 * stateless on Vercel, so we pay the connection cost once per fire.
 * BullMQ + ioredis handle pooling internally; the connection is closed
 * via finally{}.
 */
async function withScanner<T>(
  fn: (scanner: ScannerService, qualifyQueue: Queue) => Promise<T>,
): Promise<T> {
  const REDIS_URL =
    process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL || process.env.KV_URL;
  if (!REDIS_URL) {
    throw new Error('No ioredis-compatible REDIS_URL configured for BullMQ');
  }

  const redis = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
  });
  const qualifyQueue = new Queue('qualify-queue', { connection: redis });

  try {
    const scanner = new ScannerService(redis, qualifyQueue);
    return await fn(scanner, qualifyQueue);
  } finally {
    await qualifyQueue.close().catch(() => {});
    await redis.quit().catch(() => {});
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const pipelineEnabled = process.env.PIPELINE_ENABLED === 'true';
  const scannerEnabled = process.env.SCANNER_ENABLED === 'true';

  if (!pipelineEnabled || !scannerEnabled) {
    logger.debug('[cron:pipeline-scan] disabled', { pipelineEnabled, scannerEnabled });
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: 'kill-switch',
      pipelineEnabled,
      scannerEnabled,
    });
  }

  const startedAt = Date.now();
  let activeSources: SourceRow[];
  try {
    activeSources = await getActiveAPISources();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[cron:pipeline-scan] failed to load source registry', { error: msg });
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  if (activeSources.length === 0) {
    logger.debug('[cron:pipeline-scan] no sources in ingest_method=api — heartbeat only');
    return NextResponse.json({
      ok: true,
      polled: [],
      note: 'no sources in ingest_method=api — flip via /api/loadboard-sources/[source]/ingest-method',
    });
  }

  // Filter to sources whose poll interval has elapsed.
  const due = activeSources.filter(isDuePoll);
  if (due.length === 0) {
    return NextResponse.json({
      ok: true,
      polled: [],
      throttled: activeSources.map((s) => s.source),
    });
  }

  const results = await withScanner(async (scanner) => {
    const out: Array<Awaited<ReturnType<typeof scanner.pollSourceViaAPI>>> = [];
    for (const src of due) {
      // Mark polled BEFORE the poll so a hung poll doesn't get retried by
      // the next cron firing (60s later) before this one completes.
      await markPolled(src.source).catch((err) => {
        logger.warn(`[cron:pipeline-scan] markPolled failed for ${src.source}`, { error: err?.message });
      });
      try {
        const r = await scanner.pollSourceViaAPI(src.source);
        out.push(r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[cron:pipeline-scan] uncaught error polling ${src.source}`, { error: msg });
        out.push({
          source: src.source,
          status: 'failed',
          received: 0,
          inserted: 0,
          duplicates: 0,
          skipped: 0,
          insertedIds: [],
          error: msg,
        });
      }
    }
    return out;
  });

  const durationMs = Date.now() - startedAt;
  logger.info(
    `[cron:pipeline-scan] complete polled=${results.length} duration=${durationMs}ms`,
    { results: results.map((r) => ({ source: r.source, status: r.status, inserted: r.inserted })) },
  );

  return NextResponse.json({
    ok: true,
    polled: results,
    durationMs,
  });
}
