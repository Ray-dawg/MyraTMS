/**
 * Cron: feedback-aggregation
 *
 * Runs daily at 07:00 UTC. Triggers nightlyAggregationJob() which:
 *   1. Aggregates the last 30 days of agent_calls into lane_stats
 *      (origin/destination/equipment/persona × day-of-week × hour-of-day)
 *   2. Adjusts rate_adjustment_factor based on observed booking rate +
 *      avg profit (per T-11 §3.2)
 *   3. Recomputes persona-level rollups (booking_rate, avg_profit,
 *      total_revenue) — α/β are NOT touched here, those move per-call
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 * Kill switch: PIPELINE_ENABLED
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { nightlyAggregationJob } from '@/lib/workers/feedback-worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Aggregation can be moderately heavy on large windows — give it room.
export const maxDuration = 300;

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

  try {
    const r = await nightlyAggregationJob();
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    logger.error('[cron:feedback-aggregation] crash', err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
