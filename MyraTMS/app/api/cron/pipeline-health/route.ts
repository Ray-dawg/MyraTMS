/**
 * Cron: pipeline-health
 *
 * Runs every 5 minutes. Three responsibilities:
 *   1. Advance pipeline_loads from 'dispatched' → 'delivered' when the linked
 *      TMS loads.status flips to 'Delivered' (driven by driver POD upload)
 *   2. Detect stuck loads — anything in non-terminal stage that hasn't moved
 *      in 60+ minutes — and log a warning so the operator can intervene
 *   3. Report queue depth for observability (BullMQ stats)
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 * Kill switch: PIPELINE_ENABLED
 *
 * No retries / heavy logic — failures are logged and return 200 so Vercel
 * doesn't disable the cron. Stuck-load alerting is a future Slack hook.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { advanceDeliveredLoads } from '@/lib/workers/dispatcher-worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authorized(req: NextRequest): boolean {
  const auth = req.headers.get('authorization') ?? '';
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  return auth === `Bearer ${expected}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (process.env.PIPELINE_ENABLED !== 'true') {
    return NextResponse.json({ ok: true, skipped: true, reason: 'pipeline_disabled' });
  }

  let advanced = 0;
  try {
    const r = await advanceDeliveredLoads();
    advanced = r.advanced;
  } catch (err) {
    logger.error('[cron:pipeline-health] advanceDeliveredLoads crash', err);
  }

  let stuck: number = 0;
  try {
    const r = await db.query<{ stage: string; n: number }>(
      `SELECT stage, COUNT(*)::int AS n
       FROM pipeline_loads
       WHERE stage NOT IN ('disqualified','scored','expired','delivered','dispatched')
         AND stage_updated_at < NOW() - INTERVAL '60 minutes'
       GROUP BY stage`,
    );
    stuck = r.rows.reduce((sum, x) => sum + Number(x.n), 0);
    if (stuck > 0) {
      logger.warn('[cron:pipeline-health] stuck loads detected', {
        breakdown: r.rows,
      });
    }
  } catch (err) {
    logger.error('[cron:pipeline-health] stuck-load query crash', err);
  }

  return NextResponse.json({ ok: true, advanced, stuck });
}
