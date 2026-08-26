/**
 * E2-03 M5 — detectStuckPipelineLoads()/detectMissedPickupWindows() tests.
 * Tests the extracted lib functions directly, not the cron route wrapper
 * (this codebase's established convention).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { detectStuckPipelineLoads, detectMissedPickupWindows } from '@/lib/pipeline/health-checks';

const RUN_ID = Date.now();
const seededPipelineLoadIds: number[] = [];

async function seedLoad(opts: {
  stage: string;
  stageUpdatedAgo: string; // e.g. '90 minutes', '25 hours'
  pickupDateOffset?: string; // e.g. '-5 hours' for a passed pickup, '+3 days' for future
}): Promise<number> {
  const loadId = `TEST-HEALTH-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
  const pickupExpr = opts.pickupDateOffset
    ? `NOW() ${opts.pickupDateOffset.startsWith('-') ? '-' : '+'} INTERVAL '${opts.pickupDateOffset.replace(/^[+-]/, '')}'`
    : `NOW() + INTERVAL '3 days'`;

  const ins = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, origin_city, origin_state, origin_country,
       destination_city, destination_state, destination_country,
       pickup_date, delivery_date, equipment_type, weight_lbs,
       distance_miles, distance_km, shipper_company, shipper_email, shipper_phone,
       posted_rate, posted_rate_currency, stage, agreed_rate, agreed_rate_currency, profit
     ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
       ${pickupExpr}, NOW() + INTERVAL '4 days', 'Dry Van', 42000, 250, 402,
       'Health Check Co', 'x@test.test', '+17055550001', 2400, 'CAD', $2, 2200, 'CAD', 470
     ) RETURNING id`,
    [loadId, opts.stage],
  );
  const id = ins.rows[0].id;
  seededPipelineLoadIds.push(id);

  await db.query(
    `UPDATE pipeline_loads SET stage_updated_at = NOW() - INTERVAL '${opts.stageUpdatedAgo}' WHERE id = $1`,
    [id],
  );

  return id;
}

describe('detectStuckPipelineLoads (E2-03 M5)', () => {
  afterEach(async () => {
    const ids = seededPipelineLoadIds.splice(0);
    if (ids.length) {
      await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = ANY($1)`, [ids]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1)`, [ids]);
    }
  });

  it('flags a non-terminal load stuck 90+ minutes at a stage other than dispatched', async () => {
    const id = await seedLoad({ stage: 'matched', stageUpdatedAgo: '90 minutes' });
    const result = await detectStuckPipelineLoads();
    expect(result.found).toBeGreaterThanOrEqual(1);

    const exc = await db.query<{ type: string; severity: string }>(
      `SELECT type, severity FROM exceptions WHERE pipeline_load_id = $1`, [id],
    );
    expect(exc.rows).toHaveLength(1);
    expect(exc.rows[0].type).toBe('pipeline_stage_stuck');
    expect(exc.rows[0].severity).toBe('high');
  }, 30_000);

  it('does NOT flag a load at a non-terminal stage still within the 60-minute grace window', async () => {
    const id = await seedLoad({ stage: 'matched', stageUpdatedAgo: '10 minutes' });
    await detectStuckPipelineLoads();
    const exc = await db.query(`SELECT 1 FROM exceptions WHERE pipeline_load_id = $1`, [id]);
    expect(exc.rows).toHaveLength(0);
  }, 30_000);

  it('a load at dispatched for only 90 minutes is NOT flagged (dispatched gets its own 24h threshold, not 60min)', async () => {
    const id = await seedLoad({ stage: 'dispatched', stageUpdatedAgo: '90 minutes' });
    await detectStuckPipelineLoads();
    const exc = await db.query(`SELECT 1 FROM exceptions WHERE pipeline_load_id = $1`, [id]);
    expect(exc.rows).toHaveLength(0);
  }, 30_000);

  it('a load stuck at dispatched for 25+ hours IS flagged — the exclusion bug this closes', async () => {
    const id = await seedLoad({ stage: 'dispatched', stageUpdatedAgo: '25 hours' });
    const result = await detectStuckPipelineLoads();
    expect(result.found).toBeGreaterThanOrEqual(1);

    const exc = await db.query<{ type: string; severity: string }>(
      `SELECT type, severity FROM exceptions WHERE pipeline_load_id = $1`, [id],
    );
    expect(exc.rows).toHaveLength(1);
    expect(exc.rows[0].severity).toBe('medium');
  }, 30_000);

  it('does not duplicate the exceptions row on a second run (dedup on type+pipeline_load_id+active)', async () => {
    const id = await seedLoad({ stage: 'matched', stageUpdatedAgo: '90 minutes' });
    const first = await detectStuckPipelineLoads();
    const second = await detectStuckPipelineLoads();
    expect(first.written).toBeGreaterThanOrEqual(1);
    expect(second.written).toBe(0); // already-active exception, not re-written

    const exc = await db.query(`SELECT 1 FROM exceptions WHERE pipeline_load_id = $1`, [id]);
    expect(exc.rows).toHaveLength(1);
  }, 30_000);
});

describe('detectMissedPickupWindows (E2-03 M5)', () => {
  afterEach(async () => {
    const ids = seededPipelineLoadIds.splice(0);
    if (ids.length) {
      await db.query(`DELETE FROM exceptions WHERE pipeline_load_id = ANY($1)`, [ids]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1)`, [ids]);
    }
  });

  it('flags a non-terminal, pre-dispatch load whose pickup_date passed 5+ hours ago', async () => {
    const id = await seedLoad({ stage: 'briefed', stageUpdatedAgo: '1 hour', pickupDateOffset: '-5 hours' });
    const result = await detectMissedPickupWindows();
    expect(result.found).toBeGreaterThanOrEqual(1);

    const exc = await db.query<{ type: string }>(`SELECT type FROM exceptions WHERE pipeline_load_id = $1`, [id]);
    expect(exc.rows).toHaveLength(1);
    expect(exc.rows[0].type).toBe('pipeline_load_missed_pickup_window');
  }, 30_000);

  it('does NOT flag a load whose pickup_date is still in the future', async () => {
    const id = await seedLoad({ stage: 'briefed', stageUpdatedAgo: '1 hour', pickupDateOffset: '+2 days' });
    await detectMissedPickupWindows();
    const exc = await db.query(`SELECT 1 FROM exceptions WHERE pipeline_load_id = $1`, [id]);
    expect(exc.rows).toHaveLength(0);
  }, 30_000);

  it('does NOT flag a load already at dispatched — covered instead by the existing buy-side detector once a TMS loads row exists', async () => {
    const id = await seedLoad({ stage: 'dispatched', stageUpdatedAgo: '1 hour', pickupDateOffset: '-5 hours' });
    await detectMissedPickupWindows();
    const exc = await db.query(`SELECT 1 FROM exceptions WHERE pipeline_load_id = $1`, [id]);
    expect(exc.rows).toHaveLength(0);
  }, 30_000);
});
