import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Same query shape as scripts/t23_acceptance_gap_report.ts (Task 6) — kept
// in sync deliberately; this route is the live/on-demand view of the same
// measurement, not a separate metric.
export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const sinceDays = Number(req.nextUrl.searchParams.get('since') ?? '90');

  try {
    const totalsRes = await db.query<{ total: string; confirmed: string }>(
      `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE confirmed_at IS NOT NULL)::text AS confirmed
         FROM carrier_acceptance_state
        WHERE assigned_at > NOW() - ($1 || ' days')::interval`,
      [sinceDays],
    );

    const breakdownRes = await db.query<{ delivered: string; reassigned: string; pickup_late: string; unconfirmed_total: string }>(
      `WITH unconfirmed AS (
         SELECT cas.pipeline_load_id, l.status,
                (SELECT COUNT(*) FROM carrier_acceptance_state c2 WHERE c2.pipeline_load_id = cas.pipeline_load_id) AS assignment_count,
                EXISTS (SELECT 1 FROM events e WHERE e.pipeline_load_id = cas.pipeline_load_id AND e.event_type = 'load.pickup_checked_in') AS picked_up,
                pl.pickup_date
           FROM carrier_acceptance_state cas
           JOIN pipeline_loads pl ON pl.id = cas.pipeline_load_id
           LEFT JOIN loads l ON l.pipeline_load_id = pl.id
          WHERE cas.confirmed_at IS NULL AND cas.assigned_at > NOW() - ($1 || ' days')::interval
       )
       SELECT
         COUNT(*) FILTER (WHERE status IN ('Delivered', 'Invoiced', 'Closed'))::text AS delivered,
         COUNT(*) FILTER (WHERE assignment_count > 1)::text AS reassigned,
         COUNT(*) FILTER (WHERE NOT picked_up AND pickup_date < NOW() - INTERVAL '30 minutes' AND status NOT IN ('Delivered', 'Invoiced', 'Closed'))::text AS pickup_late,
         COUNT(*)::text AS unconfirmed_total
       FROM unconfirmed`,
      [sinceDays],
    );

    const total = Number(totalsRes.rows[0]?.total ?? 0);
    const confirmed = Number(totalsRes.rows[0]?.confirmed ?? 0);
    const b = breakdownRes.rows[0];

    return NextResponse.json({
      sinceDays,
      total,
      confirmed,
      unconfirmed: total - confirmed,
      unconfirmedBreakdown: {
        delivered: Number(b?.delivered ?? 0),
        reassigned: Number(b?.reassigned ?? 0),
        pickupLate: Number(b?.pickup_late ?? 0),
        total: Number(b?.unconfirmed_total ?? 0),
      },
      note: 'This schema has no cancellation status on loads — cancellation is not a trackable dimension here.',
    });
  } catch (err) {
    logger.error('[lifecycle/acceptance-gap-report GET] failed', err);
    return NextResponse.json({ error: 'Failed to compute acceptance-gap report' }, { status: 500 });
  }
}
