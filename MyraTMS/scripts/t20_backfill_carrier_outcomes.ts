/**
 * T-20 §7 acceptance criterion 3 — backfills carrier_outcome_events for
 * match_results/loads rows that existed BEFORE migration 044's triggers were
 * created (triggers only fire on new INSERT/UPDATE going forward, same
 * limitation T-17's backfill script exists for). Idempotent: relies on the
 * same UNIQUE(derived_from_table, derived_from_id, event_type, occurred_at)
 * + ON CONFLICT DO NOTHING the triggers use, so re-running is safe.
 *
 * Runs the exact same derivation logic as fn_carrier_outcome_from_match() /
 * fn_carrier_outcome_from_load_delivery() (migration 044) as one-time
 * INSERT ... SELECT statements, batched.
 *
 * Usage: DATABASE_URL=<branch or prod URL> pnpm tsx scripts/t20_backfill_carrier_outcomes.ts
 */

import { db } from '../lib/pipeline/db-adapter';

async function backfillOffered(): Promise<number> {
  const r = await db.query(
    `INSERT INTO carrier_outcome_events
       (carrier_registry_id, pipeline_load_id, event_type, occurred_at, derived_from_table, derived_from_id, payload)
     SELECT c.carrier_registry_id, pl.id, 'offered', mr.created_at, 'match_results', mr.id,
            jsonb_build_object('match_grade', mr.match_grade, 'match_score', mr.match_score)
       FROM match_results mr
       JOIN carriers c ON c.id = mr.carrier_id
       LEFT JOIN pipeline_loads pl ON pl.load_id = mr.load_id
      WHERE c.carrier_registry_id IS NOT NULL AND mr.was_selected = true
     ON CONFLICT (derived_from_table, derived_from_id, event_type, occurred_at) DO NOTHING
     RETURNING id`,
  );
  return r.rows.length;
}

async function backfillAcceptedDeclined(): Promise<number> {
  const r = await db.query(
    `INSERT INTO carrier_outcome_events
       (carrier_registry_id, pipeline_load_id, event_type, occurred_at, derived_from_table, derived_from_id, payload)
     SELECT c.carrier_registry_id, pl.id,
            CASE WHEN mr.was_accepted THEN 'accepted' ELSE 'declined' END,
            mr.created_at, 'match_results', mr.id, jsonb_build_object('match_grade', mr.match_grade)
       FROM match_results mr
       JOIN carriers c ON c.id = mr.carrier_id
       LEFT JOIN pipeline_loads pl ON pl.load_id = mr.load_id
      WHERE c.carrier_registry_id IS NOT NULL AND mr.was_accepted IS NOT NULL
     ON CONFLICT (derived_from_table, derived_from_id, event_type, occurred_at) DO NOTHING
     RETURNING id`,
  );
  return r.rows.length;
}

async function backfillDeliveries(): Promise<number> {
  const r = await db.query(
    `INSERT INTO carrier_outcome_events
       (carrier_registry_id, pipeline_load_id, event_type, occurred_at, derived_from_table, derived_from_id, payload)
     SELECT c.carrier_registry_id, l.pipeline_load_id,
            CASE WHEN l.delivery_date IS NULL OR l.updated_at::date <= l.delivery_date
                 THEN 'completed_on_time' ELSE 'completed_late' END,
            l.updated_at, 'loads', l.id,
            jsonb_build_object('delivery_date', l.delivery_date, 'revenue', l.revenue)
       FROM loads l
       JOIN carriers c ON c.id = l.carrier_id
      WHERE c.carrier_registry_id IS NOT NULL AND l.status = 'Delivered'
     ON CONFLICT (derived_from_table, derived_from_id, event_type, occurred_at) DO NOTHING
     RETURNING id`,
  );
  return r.rows.length;
}

async function main(): Promise<void> {
  const offered = await backfillOffered();
  const acceptedDeclined = await backfillAcceptedDeclined();
  const deliveries = await backfillDeliveries();

  console.log('\n=== T-20 carrier_outcome_events backfill ===');
  console.log(`offered events inserted:              ${offered}`);
  console.log(`accepted/declined events inserted:     ${acceptedDeclined}`);
  console.log(`completed_on_time/late events inserted: ${deliveries}`);
}

main().catch((err) => {
  console.error('[t20-backfill] crashed:', err);
  process.exit(1);
});
