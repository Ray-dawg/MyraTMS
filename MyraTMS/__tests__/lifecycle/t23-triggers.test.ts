// __tests__/lifecycle/t23-triggers.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

const TEST_LOAD_ID = `TEST-T23-${Date.now()}`;
const TMS_LOAD_ID = `LD-T23-${Date.now()}`;
const TEST_CARRIER_ID = `CAR-T23-${Date.now()}`;

describe('T-23 lifecycle triggers (053)', () => {
  let pipelineLoadId: number;

  beforeAll(async () => {
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, stage
       ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
                 NOW() + INTERVAL '2 days', NOW() + INTERVAL '3 days', 'Dry Van', 'dispatched')
       RETURNING id`,
      [TEST_LOAD_ID],
    );
    pipelineLoadId = ins.rows[0].id;

    await db.query(
      `INSERT INTO carriers (id, company, tenant_id) VALUES ($1, 'T23 Test Carrier', fn_myra_tenant_id())`,
      [TEST_CARRIER_ID],
    );
    await db.query(
      `INSERT INTO loads (id, origin, destination, status, pipeline_load_id)
       VALUES ($1, 'Toronto', 'Sudbury', 'Booked', $2)`,
      [TMS_LOAD_ID, pipelineLoadId],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM carrier_acceptance_state WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM events WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM loads WHERE id = $1`, [TMS_LOAD_ID]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM carriers WHERE id = $1`, [TEST_CARRIER_ID]);
  });

  it('carrier_id set → load.carrier_assigned event + assumed_unconfirmed acceptance row', async () => {
    await db.query(`UPDATE loads SET carrier_id = $1 WHERE id = $2`, [TEST_CARRIER_ID, TMS_LOAD_ID]);

    const events = await db.query(
      `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'load.carrier_assigned'`,
      [pipelineLoadId],
    );
    expect(events.rows.length).toBe(1);

    const state = await db.query(
      `SELECT confirmation_method, confirmed_at FROM carrier_acceptance_state WHERE pipeline_load_id = $1`,
      [pipelineLoadId],
    );
    expect(state.rows.length).toBe(1);
    expect(state.rows[0].confirmation_method).toBe('assumed_unconfirmed');
    expect(state.rows[0].confirmed_at).toBeNull();
  });

  it('carrier_signature_received_at set → backfills confirmed_at + emits load.carrier_acceptance_confirmed', async () => {
    await db.query(
      `UPDATE loads SET carrier_signature_received_at = NOW(), carrier_signature_method = 'email_verified', carrier_signature_confirmed_by = 'imap-poller' WHERE id = $1`,
      [TMS_LOAD_ID],
    );

    const state = await db.query(
      `SELECT confirmation_method, confirmed_at FROM carrier_acceptance_state WHERE pipeline_load_id = $1`,
      [pipelineLoadId],
    );
    expect(state.rows[0].confirmation_method).toBe('rate_con_signed');
    expect(state.rows[0].confirmed_at).not.toBeNull();

    const events = await db.query(
      `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'load.carrier_acceptance_confirmed'`,
      [pipelineLoadId],
    );
    expect(events.rows.length).toBe(1);
  });

  it('status → In Transit emits load.pickup_checked_in exactly once', async () => {
    await db.query(`UPDATE loads SET status = 'In Transit' WHERE id = $1`, [TMS_LOAD_ID]);
    const events = await db.query(
      `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'load.pickup_checked_in'`,
      [pipelineLoadId],
    );
    expect(events.rows.length).toBe(1);
  });

  it('pod_url set emits load.pod_captured', async () => {
    await db.query(`UPDATE loads SET pod_url = 'https://blob.example/pod.jpg' WHERE id = $1`, [TMS_LOAD_ID]);
    const events = await db.query(
      `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'load.pod_captured'`,
      [pipelineLoadId],
    );
    expect(events.rows.length).toBe(1);
  });

  it('a manual (non-pipeline) load produces zero lifecycle events', async () => {
    const manualLoadId = `LD-MANUAL-${Date.now()}`;
    await db.query(
      `INSERT INTO loads (id, origin, destination, status) VALUES ($1, 'A', 'B', 'Booked')`,
      [manualLoadId],
    );
    await db.query(`UPDATE loads SET carrier_id = $1 WHERE id = $2`, [TEST_CARRIER_ID, manualLoadId]);
    const events = await db.query(
      `SELECT * FROM events WHERE derived_from_table = 'loads' AND payload->>'load_id' = $1`,
      [manualLoadId],
    );
    expect(events.rows.length).toBe(0);
    await db.query(`DELETE FROM loads WHERE id = $1`, [manualLoadId]);
  });

  it('v_lifecycle_late_loads flags a load past pickup_date with no check-in, and does not flag an on-time one', async () => {
    const lateLoad = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type, stage)
       VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
               NOW() - INTERVAL '2 hours', NOW() + INTERVAL '1 day', 'Dry Van', 'dispatched')
       RETURNING id`,
      [`TEST-T23-LATE-${Date.now()}`],
    );
    const lateId = lateLoad.rows[0].id;

    const onTimeLoad = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type, stage)
       VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
               NOW() + INTERVAL '1 day', NOW() + INTERVAL '2 days', 'Dry Van', 'dispatched')
       RETURNING id`,
      [`TEST-T23-ONTIME-${Date.now()}`],
    );
    const onTimeId = onTimeLoad.rows[0].id;

    const view = await db.query<{ pipeline_load_id: number; late_status: string | null }>(
      `SELECT pipeline_load_id, late_status FROM v_lifecycle_late_loads WHERE pipeline_load_id IN ($1, $2)`,
      [lateId, onTimeId],
    );
    expect(view.rows.find((r) => r.pipeline_load_id === lateId)?.late_status).toBe('pickup_late');
    expect(view.rows.find((r) => r.pipeline_load_id === onTimeId)?.late_status).toBeNull();

    await db.query(`DELETE FROM pipeline_loads WHERE id IN ($1, $2)`, [lateId, onTimeId]);
  });
});
