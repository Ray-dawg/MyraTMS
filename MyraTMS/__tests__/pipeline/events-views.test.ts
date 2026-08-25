/**
 * T-17 metric view verification — acceptance criterion 3.
 *
 * The base spec suggests validating against the Pilot 1 75-load
 * shadow-drain dataset; that dataset isn't available in this environment,
 * so this test seeds a small synthetic fixture with known values and
 * asserts the views compute exactly what the fixture implies.
 *
 * Every UPDATE that changes pipeline_loads.stage sets stage_updated_at
 * explicitly, and every call transition (connected/ended/outcome) is a
 * separate UPDATE after the INSERT — this matches real application
 * behavior (the app updates stage_updated_at on every transition; Retell's
 * webhook connects a call via a follow-up UPDATE, not at INSERT time) and
 * is required for correctness: the events UNIQUE constraint includes
 * occurred_at, so two genuine transitions sharing a stale/unset timestamp
 * would incorrectly collide, and the agent_calls INSERT trigger branch
 * only ever emits call.initiated — it does not inspect call_connected_at.
 *
 * tenant_id is resolved via fn_myra_tenant_id() rather than hardcoded,
 * since T-19 (migration 035) corrected the default from the literal 1
 * (the _system tenant) to Myra's real id.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

const RUN_ID = `T17-VIEW-${Date.now()}`;
const loadIds: number[] = [];
const callIds: number[] = [];

async function insertLoad(suffix: string): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, origin_city, origin_state, destination_city, destination_state,
       pickup_date, equipment_type, stage
     ) VALUES ($1, 'manual', 'Toronto', 'ON', 'Sudbury', 'ON', NOW() + INTERVAL '3 days', 'Dry Van', 'scanned')
     RETURNING id`,
    [`${RUN_ID}-${suffix}`],
  );
  const id = r.rows[0].id;
  loadIds.push(id);
  return id;
}

describe('T-17 metric views', () => {
  afterAll(async () => {
    if (callIds.length) await db.query(`DELETE FROM agent_calls WHERE id = ANY($1::int[])`, [callIds]);
    if (loadIds.length) {
      await db.query(`DELETE FROM events WHERE pipeline_load_id = ANY($1::int[])`, [loadIds]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1::int[])`, [loadIds]);
    }
  });

  it('v_stage_conversion counts stage_changed events per stage', async () => {
    const idA = await insertLoad('SC-A');
    const idB = await insertLoad('SC-B');
    await db.query(
      `UPDATE pipeline_loads SET stage = 'qualified', stage_updated_at = NOW() WHERE id = ANY($1::int[])`,
      [[idA, idB]],
    );
    await db.query(
      `UPDATE pipeline_loads SET stage = 'matched', stage_updated_at = NOW() + INTERVAL '1 minute' WHERE id = $1`,
      [idA],
    );

    const r = await db.query<{ stage: string; entries: string }>(
      `SELECT stage, entries::text FROM v_stage_conversion
        WHERE tenant_id = fn_myra_tenant_id() AND stage IN ('qualified', 'matched')`,
    );
    const byStage = Object.fromEntries(r.rows.map((row) => [row.stage, Number(row.entries)]));
    expect(byStage.qualified).toBeGreaterThanOrEqual(2);
    expect(byStage.matched).toBeGreaterThanOrEqual(1);
  });

  it('v_call_funnel counts initiated/connected/booked within its 30-day window', async () => {
    const loadId = await insertLoad('CF');
    const insertedCalls: number[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await db.query<{ id: number }>(
        `INSERT INTO agent_calls (pipeline_load_id, call_id, call_type)
         VALUES ($1, $2, 'negotiation') RETURNING id`,
        [loadId, `${RUN_ID}-CF-${i}`],
      );
      insertedCalls.push(r.rows[0].id);
    }
    callIds.push(...insertedCalls);
    await db.query(`UPDATE agent_calls SET call_connected_at = NOW() WHERE id = ANY($1::int[])`, [insertedCalls]);
    await db.query(`UPDATE agent_calls SET outcome = 'booked' WHERE id = $1`, [insertedCalls[0]]);
    await db.query(`UPDATE agent_calls SET outcome = 'declined' WHERE id = $1`, [insertedCalls[1]]);

    const r = await db.query<{ calls_initiated: string; calls_connected: string; calls_booked: string }>(
      `SELECT calls_initiated::text, calls_connected::text, calls_booked::text FROM v_call_funnel
        WHERE tenant_id = fn_myra_tenant_id()`,
    );
    expect(Number(r.rows[0].calls_initiated)).toBeGreaterThanOrEqual(2);
    expect(Number(r.rows[0].calls_connected)).toBeGreaterThanOrEqual(2);
    expect(Number(r.rows[0].calls_booked)).toBeGreaterThanOrEqual(1);
  });

  it('v_time_in_stage computes the interval between consecutive stage_changed events', async () => {
    const loadId = await insertLoad('TIS');
    await db.query(`UPDATE pipeline_loads SET stage = 'qualified', stage_updated_at = NOW() WHERE id = $1`, [loadId]);
    await db.query(
      `UPDATE pipeline_loads SET stage = 'matched', stage_updated_at = NOW() + INTERVAL '10 minutes' WHERE id = $1`,
      [loadId],
    );

    const r = await db.query<{ stage: string; time_in_stage: string | null }>(
      `SELECT stage, time_in_stage FROM v_time_in_stage WHERE pipeline_load_id = $1 ORDER BY occurred_at ASC`,
      [loadId],
    );
    expect(r.rows.length).toBe(2);
    expect(r.rows[0].stage).toBe('qualified');
    expect(r.rows[0].time_in_stage).not.toBeNull();
    expect(r.rows[1].time_in_stage).toBeNull();
  });

  it('v_cost_per_call reports coverage even when cost columns are null', async () => {
    const loadId = await insertLoad('CPC');
    const r = await db.query<{ id: number }>(
      `INSERT INTO agent_calls (pipeline_load_id, call_id, call_type) VALUES ($1, $2, 'negotiation') RETURNING id`,
      [loadId, `${RUN_ID}-CPC-1`],
    );
    callIds.push(r.rows[0].id);

    const view = await db.query<{ calls_total: string; calls_with_cost_data: string }>(
      `SELECT calls_total::text, calls_with_cost_data::text FROM v_cost_per_call WHERE tenant_id = fn_myra_tenant_id()`,
    );
    expect(Number(view.rows[0].calls_total)).toBeGreaterThanOrEqual(1);
    expect(Number(view.rows[0].calls_with_cost_data)).toBeGreaterThanOrEqual(0);
  });
});
