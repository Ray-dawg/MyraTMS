// __tests__/documents/t26-rate-con-signed-e2e.test.ts
//
// Acceptance criterion 4: proves the REAL call path already closes T-23's
// acceptance gap, end to end, with zero new production code. Exercises
// completeDispatchOnSignedRateCon() (E2-04 M6, unmodified) and confirms
// T-23's own fn_lifecycle_events_from_loads() trigger (migration 053,
// already live) picks up the resulting carrier_signature_received_at
// change and updates carrier_acceptance_state.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { completeDispatchOnSignedRateCon } from '@/lib/dispatch-gate';

const REF = `T26E2E-${Date.now()}`;

describe('T-26 criterion 4 — already satisfied by T-23 + completeDispatchOnSignedRateCon()', () => {
  let pipelineLoadId: number;
  let tmsLoadId: string;
  const carrierId = `CAR-${REF}`;

  beforeAll(async () => {
    const pl = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type, stage)
       VALUES ($1, 'DAT', 'A', 'ON', 'CA', 'B', 'ON', 'CA', NOW(), NOW(), 'Dry Van', 'dispatched') RETURNING id`,
      [`${REF}-PL`],
    );
    pipelineLoadId = pl.rows[0].id;
    tmsLoadId = `LD-${REF}`;
    await db.query(`INSERT INTO carriers (id, company, tenant_id) VALUES ($1, 'T26 Test Carrier', 2)`, [carrierId]);
    await db.query(
      `INSERT INTO loads (id, origin, destination, status, pipeline_load_id, carrier_id)
       VALUES ($1, 'A', 'B', 'Awaiting Signature', $2, $3)`,
      [tmsLoadId, pipelineLoadId, carrierId],
    );
    await db.query(
      `INSERT INTO carrier_acceptance_state (pipeline_load_id, assigned_at, confirmation_method, confirmed_at)
       VALUES ($1, NOW(), 'assumed_unconfirmed', NULL)`,
      [pipelineLoadId],
    );
  });

  afterAll(async () => {
    await db.query(`DELETE FROM carrier_acceptance_state WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM events WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM documents WHERE related_to = $1`, [tmsLoadId]);
    await db.query(`DELETE FROM loads WHERE id = $1`, [tmsLoadId]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM carriers WHERE id = $1`, [carrierId]);
  });

  it('completeDispatchOnSignedRateCon sets carrier_signature_received_at, and T-23s existing trigger closes the loop', async () => {
    const result = await completeDispatchOnSignedRateCon({
      tenantId: 2,
      loadId: tmsLoadId,
      method: 'email_verified',
    });
    expect(result.outcome).toBe('dispatched');

    const state = await db.query<{ confirmation_method: string; confirmed_at: string | null }>(
      `SELECT confirmation_method, confirmed_at FROM carrier_acceptance_state WHERE pipeline_load_id = $1`,
      [pipelineLoadId],
    );
    expect(state.rows[0].confirmation_method).toBe('rate_con_signed');
    expect(state.rows[0].confirmed_at).not.toBeNull();
  });
});
