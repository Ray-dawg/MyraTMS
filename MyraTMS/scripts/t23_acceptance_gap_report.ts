// scripts/t23_acceptance_gap_report.ts
//
// T-23 §5 — the measurement report. Prints, does not just compute: this
// script's actual printed output (not a description of it) is the required
// deliverable this module hands to Patrice before T-23b's priority is
// decided (spec §8's exit gate).

import { db } from '../lib/pipeline/db-adapter';

async function main(): Promise<void> {
  const sinceArg = process.argv.find((a) => a.startsWith('--since='));
  const sinceDays = sinceArg ? Number(sinceArg.split('=')[1]) : 90;

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
  const unconfirmed = total - confirmed;
  const b = breakdownRes.rows[0];
  const delivered = Number(b?.delivered ?? 0);
  const reassigned = Number(b?.reassigned ?? 0);
  const pickupLate = Number(b?.pickup_late ?? 0);
  const pct = (n: number, d: number) => (d === 0 ? 'n/a (0 in window)' : `${((n / d) * 100).toFixed(1)}%`);

  console.log(`T-23 Acceptance Gap Report — last ${sinceDays} days`);
  console.log('='.repeat(60));
  console.log(`Total loads dispatched (carrier_acceptance_state rows): ${total}`);
  console.log(`  Real confirmation signal:  ${confirmed} (${pct(confirmed, total)})`);
  console.log(`  assumed_unconfirmed:       ${unconfirmed} (${pct(unconfirmed, total)})`);
  console.log('');
  console.log(`Of the ${unconfirmed} unconfirmed loads:`);
  console.log(`  Delivered successfully anyway: ${delivered} (${pct(delivered, unconfirmed)})`);
  console.log(`  Later reassigned to another carrier: ${reassigned} (${pct(reassigned, unconfirmed)})`);
  console.log(`  Pickup went late with no check-in: ${pickupLate} (${pct(pickupLate, unconfirmed)})`);
  console.log('');
  console.log('Note: this schema has no cancellation status on loads.status —');
  console.log('cancellation is not a measurable dimension here, not omitted by oversight.');
}

main().catch((err) => {
  console.error('[t23-acceptance-gap-report] failed:', err);
  process.exit(1);
});
