/**
 * Qualifier (Agent 2) integration test.
 * Inserts a synthetic pipeline_load, runs the worker against the live
 * Neon DB and live Upstash Redis, then asserts the row advances correctly.
 *
 * Requires .env.local. Run: pnpm vitest run __tests__/pipeline/qualifier.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { QualifierWorker, type QualifyJobPayload } from '@/lib/workers/qualifier-worker';

const TEST_LOAD_ID = `TEST-Q-${Date.now()}`;
const TEST_PHONE = `+15551${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;

describe('QualifierWorker', () => {
  let pipelineLoadId: number;
  let researchQueue: Queue;
  let matchQueue: Queue;
  let worker: QualifierWorker;

  beforeAll(async () => {
    researchQueue = new Queue('research-queue-test', { connection: redisConnection });
    matchQueue = new Queue('match-queue-test', { connection: redisConnection });
    worker = new QualifierWorker(redisConnection, researchQueue, matchQueue);

    const res = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, equipment_type,
         posted_rate, posted_rate_currency, distance_miles, stage, shipper_phone
       ) VALUES (
         $1, 'csv', 'Chicago', 'IL', 'US',
         'Dallas', 'TX', 'US',
         NOW() + INTERVAL '3 days', 'Dry Van',
         2400, 'USD', 920, 'scanned', $2
       ) RETURNING id`,
      [TEST_LOAD_ID, TEST_PHONE],
    );
    pipelineLoadId = res.rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await researchQueue.obliterate({ force: true });
    await matchQueue.obliterate({ force: true });
    await researchQueue.close();
    await matchQueue.close();
  });

  it('qualifies a fresh, profitable, non-DNC load and fans out to both queues', async () => {
    const payload: QualifyJobPayload = {
      pipelineLoadId,
      loadId: TEST_LOAD_ID,
      loadBoardSource: 'csv',
      enqueuedAt: new Date().toISOString(),
      priority: 0,
      origin: { city: 'Chicago', state: 'IL', country: 'US' },
      destination: { city: 'Dallas', state: 'TX', country: 'US' },
      equipmentType: 'Dry Van',
      postedRate: 2400,
      postedRateCurrency: 'USD',
      distanceMiles: 920,
      pickupDate: new Date(Date.now() + 3 * 86400_000).toISOString(),
      shipperPhone: TEST_PHONE,
    };

    const result = await worker.process(payload);
    expect(result.success).toBe(true);
    expect(result.details?.passed).toBe(true);
    expect(result.details?.priorityScore).toBeGreaterThan(0);

    // The base worker only calls updatePipelineLoad after process() — we trigger
    // it manually here since the test bypasses BullMQ's job lifecycle.
    await (worker as any).updatePipelineLoad(pipelineLoadId, result);

    const after = await db.query<{ stage: string; priority_score: number; carrier_match_count: number }>(
      `SELECT stage, priority_score, carrier_match_count FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    expect(after.rows[0].stage).toBe('qualified');
    expect(after.rows[0].priority_score).toBeGreaterThan(0);

    // Jobs added with priority go into BullMQ's 'prioritized' state, not 'waiting'.
    const researchJobs = await researchQueue.getJobs(['waiting', 'prioritized', 'active', 'delayed']);
    const matchJobs = await matchQueue.getJobs(['waiting', 'prioritized', 'active', 'delayed']);
    expect(researchJobs.length).toBe(1);
    expect(matchJobs.length).toBe(1);
    expect(researchJobs[0].data.pipelineLoadId).toBe(pipelineLoadId);
    expect(matchJobs[0].data.qualifiedLoad.equipmentType).toBe('Dry Van');
  });

  it('disqualifies a load whose pickup is 1 hour away (freshness filter)', async () => {
    const tooSoonPayload: QualifyJobPayload = {
      pipelineLoadId, // reuse — disqualified update overwrites stage
      loadId: TEST_LOAD_ID,
      loadBoardSource: 'csv',
      enqueuedAt: new Date().toISOString(),
      priority: 0,
      origin: { city: 'Chicago', state: 'IL', country: 'US' },
      destination: { city: 'Dallas', state: 'TX', country: 'US' },
      equipmentType: 'Dry Van',
      postedRate: 2400,
      postedRateCurrency: 'USD',
      distanceMiles: 920,
      pickupDate: new Date(Date.now() + 1 * 3600_000).toISOString(),
      shipperPhone: null,
    };

    const result = await worker.process(tooSoonPayload);
    expect(result.details?.passed).toBe(false);
    expect(result.details?.reason).toMatch(/4 hours/);
  });
});

/**
 * Shadow shipper-direct classification + evaluatePolicy() wiring (E2-01 M1 +
 * T-19, 2026-08-25). SHIPPER_DIRECT_GATE_ENABLED defaults to unset/false in
 * every other test in this file (and in production) — these tests are the
 * only place it's flipped on, and restore it afterward.
 */
describe('QualifierWorker — shadow shipper-direct classification', () => {
  let pipelineLoadId: number;
  let researchQueue: Queue;
  let matchQueue: Queue;
  let worker: QualifierWorker;
  const loadId = `TEST-Q-SHADOW-${Date.now()}`;
  const originalGateEnv = process.env.SHIPPER_DIRECT_GATE_ENABLED;

  beforeAll(async () => {
    researchQueue = new Queue('research-queue-test-shadow', { connection: redisConnection });
    matchQueue = new Queue('match-queue-test-shadow', { connection: redisConnection });
    worker = new QualifierWorker(redisConnection, researchQueue, matchQueue);

    const res = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, equipment_type,
         posted_rate, posted_rate_currency, distance_miles, stage
       ) VALUES (
         $1, 'csv', 'Chicago', 'IL', 'US',
         'Dallas', 'TX', 'US',
         NOW() + INTERVAL '3 days', 'Dry Van',
         2400, 'USD', 920, 'scanned'
       ) RETURNING id`,
      [loadId],
    );
    pipelineLoadId = res.rows[0].id;
  });

  afterAll(async () => {
    process.env.SHIPPER_DIRECT_GATE_ENABLED = originalGateEnv;
    await db.query(`DELETE FROM authority_evaluations WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await researchQueue.obliterate({ force: true });
    await matchQueue.obliterate({ force: true });
    await researchQueue.close();
    await matchQueue.close();
  });

  function basePayload(): QualifyJobPayload {
    return {
      pipelineLoadId,
      loadId,
      loadBoardSource: 'csv',
      enqueuedAt: new Date().toISOString(),
      priority: 0,
      origin: { city: 'Chicago', state: 'IL', country: 'US' },
      destination: { city: 'Dallas', state: 'TX', country: 'US' },
      equipmentType: 'Dry Van',
      postedRate: 2400,
      postedRateCurrency: 'USD',
      distanceMiles: 920,
      pickupDate: new Date(Date.now() + 3 * 86400_000).toISOString(),
      shipperPhone: null,
    };
  }

  it('gate disabled (default): no classification runs, nothing is persisted, qualification is unaffected', async () => {
    delete process.env.SHIPPER_DIRECT_GATE_ENABLED;

    const result = await worker.process(basePayload());
    expect(result.details?.passed).toBe(true);
    expect(result.details?.sourceClassification).toBeNull();

    await (worker as any).updatePipelineLoad(pipelineLoadId, result);
    const after = await db.query<{ stage: string; load_source_class: string | null }>(
      `SELECT stage, load_source_class FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    expect(after.rows[0].stage).toBe('qualified');
    expect(after.rows[0].load_source_class).toBeNull();
  });

  it('gate enabled, no poster identity captured: classifies unresolved, evaluatePolicy() rejects, but the load still qualifies normally', async () => {
    process.env.SHIPPER_DIRECT_GATE_ENABLED = 'true';

    const result = await worker.process(basePayload());
    // The real filter chain (freshness/equipment/margin/DNC/fatigue) still
    // decides qualify/disqualify — the shadow classification must never
    // change this outcome.
    expect(result.details?.passed).toBe(true);

    const shadow = result.details?.sourceClassification;
    expect(shadow).not.toBeNull();
    expect(shadow.classification.class).toBe('unresolved');
    expect(shadow.classification.reasonCode).toBe('poster_identity_missing');
    expect(shadow.policyResult).not.toBeNull();
    expect(shadow.policyResult.decision).toBe('reject'); // no MC number can match a co-broker agreement

    await (worker as any).updatePipelineLoad(pipelineLoadId, result);

    const after = await db.query<{
      stage: string;
      load_source_class: string | null;
      load_source_evaluated_at: string | null;
      qualification_detail: string | null;
    }>(
      `SELECT stage, load_source_class, load_source_evaluated_at, qualification_detail
         FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    // Still qualified — the real qualification_reason column (asserted via
    // stage here) was set by the real filter chain, not by the shadow gate.
    expect(after.rows[0].stage).toBe('qualified');
    expect(after.rows[0].load_source_class).toBe('unresolved');
    expect(after.rows[0].load_source_evaluated_at).not.toBeNull();
    expect(after.rows[0].qualification_detail).toContain('evaluatePolicy=reject');

    // evaluatePolicy() really ran end-to-end, not just returned a value in
    // memory — it logged its own audit row under the policy_engine agent.
    const evalRow = await db.query<{ decision: string }>(
      `SELECT ae.decision FROM authority_evaluations ae
         JOIN agents a ON a.id = ae.agent_id
        WHERE a.agent_key = 'policy_engine' AND ae.pipeline_load_id = $1`,
      [pipelineLoadId],
    );
    expect(evalRow.rows.length).toBeGreaterThan(0);
    expect(evalRow.rows[0].decision).toBe('deny');
  });
});
