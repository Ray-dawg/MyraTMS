// scripts/t23_backfill_carrier_acceptance_state.ts
//
// Seeds carrier_acceptance_state for pipeline loads dispatched before
// migration 053's trigger existed. Uses the identical assumed_unconfirmed /
// rate_con_signed / manual_call classification the trigger applies live
// (053) so a backfilled row is indistinguishable from one the trigger
// would have written in real time.

import { db } from '../lib/pipeline/db-adapter';

interface BackfillCandidate {
  pipeline_load_id: number;
  carrier_registry_id: number | null;
  assigned_at: Date;
  carrier_signature_received_at: Date | null;
  carrier_signature_method: string | null;
  carrier_signature_confirmed_by: string | null;
}

export async function backfillCarrierAcceptanceState(): Promise<{ inserted: number; candidates: number }> {
  const { rows } = await db.query<BackfillCandidate>(`
    SELECT pl.id AS pipeline_load_id,
           c.carrier_registry_id,
           COALESCE(pl.dispatched_at, pl.stage_updated_at, pl.created_at) AS assigned_at,
           l.carrier_signature_received_at, l.carrier_signature_method, l.carrier_signature_confirmed_by
      FROM pipeline_loads pl
      JOIN loads l ON l.pipeline_load_id = pl.id
      LEFT JOIN carriers c ON c.id = l.carrier_id
     WHERE pl.stage IN ('dispatched', 'delivered')
       AND l.carrier_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM carrier_acceptance_state cas WHERE cas.pipeline_load_id = pl.id)
  `);

  let inserted = 0;
  for (const row of rows) {
    const method = row.carrier_signature_received_at
      ? row.carrier_signature_method === 'manual_ops'
        ? 'manual_call'
        : 'rate_con_signed'
      : 'assumed_unconfirmed';

    await db.query(
      `INSERT INTO carrier_acceptance_state
         (pipeline_load_id, carrier_registry_id, assigned_at, confirmation_method, confirmed_at, confirmation_source)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        row.pipeline_load_id,
        row.carrier_registry_id,
        row.assigned_at,
        method,
        row.carrier_signature_received_at,
        row.carrier_signature_confirmed_by,
      ],
    );
    inserted += 1;
  }

  return { inserted, candidates: rows.length };
}

async function main(): Promise<void> {
  const result = await backfillCarrierAcceptanceState();
  console.log(`Backfilled ${result.inserted} of ${result.candidates} candidate carrier_acceptance_state rows.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[t23-backfill] failed:', err);
    process.exit(1);
  });
}
