// __tests__/lifecycle/t23-backfill.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { backfillCarrierAcceptanceState } from '../../scripts/t23_backfill_carrier_acceptance_state';

describe('t23_backfill_carrier_acceptance_state', () => {
  let pipelineLoadId: number;
  const tmsLoadId = `LD-BACKFILL-${Date.now()}`;
  const carrierId = `CAR-BACKFILL-${Date.now()}`;

  beforeAll(async () => {
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type, stage, dispatched_at)
       VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
               NOW() - INTERVAL '10 days', NOW() - INTERVAL '9 days', 'Dry Van', 'delivered', NOW() - INTERVAL '10 days')
       RETURNING id`,
      [`TEST-BACKFILL-${Date.now()}`],
    );
    pipelineLoadId = ins.rows[0].id;
    await db.query(`INSERT INTO carriers (id, company, tenant_id) VALUES ($1, 'Backfill Carrier', fn_myra_tenant_id())`, [carrierId]);
    // Inserted directly with carrier_id already set — simulates a load
    // dispatched BEFORE the migration 053 trigger existed (no
    // carrier_acceptance_state row is created by this insert).
    await db.query(
      `INSERT INTO loads (id, origin, destination, status, carrier_id, pipeline_load_id) VALUES ($1, 'A', 'B', 'Delivered', $2, $3)`,
      [tmsLoadId, carrierId, pipelineLoadId],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM carrier_acceptance_state WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM loads WHERE id = $1`, [tmsLoadId]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM carriers WHERE id = $1`, [carrierId]);
  });

  it('inserts an assumed_unconfirmed row for a pre-existing dispatched load with no acceptance row yet', async () => {
    const result = await backfillCarrierAcceptanceState();
    expect(result.inserted).toBeGreaterThanOrEqual(1);

    const row = await db.query(
      `SELECT confirmation_method, confirmed_at FROM carrier_acceptance_state WHERE pipeline_load_id = $1`,
      [pipelineLoadId],
    );
    expect(row.rows.length).toBe(1);
    expect(row.rows[0].confirmation_method).toBe('assumed_unconfirmed');
  });

  it('is idempotent — a second run inserts nothing new for the same load', async () => {
    const before = await db.query(`SELECT COUNT(*) FROM carrier_acceptance_state WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await backfillCarrierAcceptanceState();
    const after = await db.query(`SELECT COUNT(*) FROM carrier_acceptance_state WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
