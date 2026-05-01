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
