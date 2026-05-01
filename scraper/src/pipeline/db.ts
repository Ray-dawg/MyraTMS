/**
 * pipeline_loads writer.
 *
 * Mirrors the column shape used by MyraTMS/lib/workers/scanner-worker.ts
 * `ingestRawLoads()`. Same INSERT, same ON CONFLICT, same stage='scanned'.
 * The only marker that distinguishes scrape-sourced loads is
 * `created_by = 'scraper-v1'` (vs `'scanner-csv-v1'` for CSV ingest and
 * `'scanner-v1'` for the API path).
 *
 * Returns { id, isNew } when a row was inserted, null on conflict.
 */

import type { Pool } from 'pg';
import type { RawLoad } from './normalize.js';

export interface InsertResult {
  id: number;
  isNew: boolean;
}

export async function writePipelineLoad(db: Pool, load: RawLoad): Promise<InsertResult | null> {
  const result = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source,
       origin_city, origin_state, origin_country,
       destination_city, destination_state, destination_country,
       pickup_date, delivery_date,
       equipment_type, commodity, weight_lbs, distance_miles,
       shipper_company, shipper_contact_name, shipper_phone, shipper_email,
       posted_rate, posted_rate_currency, rate_type,
       stage, stage_updated_at, created_by
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20, $21,
       'scanned', NOW(), 'scraper-v1'
     )
     ON CONFLICT (load_id, load_board_source) DO NOTHING
     RETURNING id`,
    [
      load.loadId,
      load.loadBoardSource,
      load.originCity,
      load.originState,
      load.originCountry,
      load.destinationCity,
      load.destinationState,
      load.destinationCountry,
      load.pickupDate,
      load.deliveryDate,
      load.equipmentType,
      load.commodity,
      load.weightLbs,
      load.distanceMiles,
      load.shipperCompany,
      load.shipperContactName,
      load.shipperPhone,
      load.shipperEmail,
      load.postedRate,
      load.postedRateCurrency,
      load.rateType,
    ],
  );

  if ((result.rowCount ?? 0) === 0) return null; // duplicate
  return { id: result.rows[0].id, isNew: true };
}
