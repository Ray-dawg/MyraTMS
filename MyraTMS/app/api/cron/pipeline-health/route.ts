/**
 * Cron: pipeline-health
 *
 * Runs every 5 minutes. Three responsibilities:
 *   1. Advance pipeline_loads from 'dispatched' → 'delivered' when the linked
 *      TMS loads.status flips to 'Delivered' (driven by driver POD upload)
 *   2. Health checks (E2-03 M5, see lib/pipeline/health-checks.ts):
 *      stuck-load detection (now including 'dispatched', with its own 24h
 *      threshold instead of being excluded entirely) and pre-dispatch
 *      missed-pickup-window detection — both write visible exceptions rows
 *   3. Report queue depth for observability (BullMQ stats)
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 * Kill switch: PIPELINE_ENABLED
 *
 * No retries / heavy logic — failures are logged and return 200 so Vercel
 * doesn't disable the cron. Purely observational: writes exceptions rows,
 * no automated remediation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { advanceDeliveredLoads } from '@/lib/workers/dispatcher-worker';
import { detectStuckPipelineLoads, detectMissedPickupWindows } from '@/lib/pipeline/health-checks';

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

  const stuckResult = await detectStuckPipelineLoads();
  const latePickupResult = await detectMissedPickupWindows();

  return NextResponse.json({
    ok: true,
    advanced,
    stuck: stuckResult.found,
    stuckWritten: stuckResult.written,
    latePickup: latePickupResult.found,
    latePickupWritten: latePickupResult.written,
  });
}
