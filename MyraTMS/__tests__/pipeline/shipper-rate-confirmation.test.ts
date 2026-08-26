/**
 * generateShipperRateConfirmation() integration test (E2-04 M2).
 * Inserts a synthetic pipeline_load at 'booked' with an agreed_rate, runs
 * the generator against live Neon, asserts a real PDF buffer comes back.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { generateShipperRateConfirmation } from '@/lib/shipper-rate-confirmation';

const TEST_LOAD_ID = `TEST-SRC-${Date.now()}`;

describe('generateShipperRateConfirmation (E2-04 M2)', () => {
  let pipelineLoadId: number;

  beforeAll(async () => {
    const res = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, commodity, weight_lbs,
         shipper_company, shipper_contact_name, shipper_phone, shipper_email,
         stage, agreed_rate, agreed_rate_currency, booked_at
       ) VALUES (
         $1, 'DAT', 'Toronto', 'ON', 'CA',
         'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 'general freight', 42000,
         'Northern Mine Supply Co', 'Jean-Marc Tremblay', '+15551234567', 'jm@nmsco.ca',
         'booked', 2200.00, 'CAD', NOW()
       ) RETURNING id`,
      [TEST_LOAD_ID],
    );
    pipelineLoadId = res.rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
  });

  it('generates a non-empty PDF buffer with the agreed rate', async () => {
    const buf = await generateShipperRateConfirmation(pipelineLoadId);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });

  it('throws for a nonexistent pipeline_load id', async () => {
    await expect(generateShipperRateConfirmation(999_999_999)).rejects.toThrow(
      'pipeline_loads 999999999 not found',
    );
  });
});
