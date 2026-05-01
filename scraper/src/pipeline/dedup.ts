/**
 * Cross-source dedup.
 *
 * Within-source dedup is enforced at the database level via
 * UNIQUE (load_id, load_board_source) — re-posts (same load_id appearing in
 * subsequent polls of the same board) are silently dropped on insert.
 *
 * Cross-source dedup is harder: the same load can appear on DAT and 123LB
 * with different load_ids. The signal that survives across boards is the
 * shipper contact + lane + pickup date + equipment, within a 24-hour window.
 * Without a phone number we can't dedup reliably, so we don't try.
 */

import type { Pool } from 'pg';
import type { RawLoad } from './normalize.js';

export async function isCrossSourceDuplicate(db: Pool, load: RawLoad): Promise<boolean> {
  if (!load.shipperPhone) return false; // can't dedup without contact

  const result = await db.query(
    `SELECT id FROM pipeline_loads
       WHERE shipper_phone = $1
         AND origin_city = $2 AND origin_state = $3
         AND destination_city = $4 AND destination_state = $5
         AND DATE(pickup_date) = DATE($6)
         AND equipment_type = $7
         AND created_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
    [
      load.shipperPhone,
      load.originCity,
      load.originState,
      load.destinationCity,
      load.destinationState,
      load.pickupDate,
      load.equipmentType,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}
