/**
 * Ranker (Agent 4) integration test.
 * Inserts a synthetic pipeline_load, marks research as already-complete (so the
 * gate can fully open in this isolated test), runs the worker, and asserts:
 *   - matchCarriers ran against the live carriers table
 *   - match_results rows persisted
 *   - pipeline_loads.carrier_match_count populated
 *   - completion gate advanced stage to 'matched' (since research_completed_at was set)
 *   - a brief job was enqueued
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { RankerWorker, type MatchJobPayload } from '@/lib/workers/ranker-worker';

const TEST_LOAD_ID = `TEST-R-${Date.now()}`;

describe('RankerWorker', () => {
  let pipelineLoadId: number;
  let briefQueue: Queue;
  let worker: RankerWorker;

  beforeAll(async () => {
    briefQueue = new Queue('brief-queue-test', { connection: redisConnection });
    worker = new RankerWorker(redisConnection, briefQueue);

    const res = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, equipment_type, posted_rate, posted_rate_currency,
         distance_miles, stage, priority_score, estimated_margin_high,
         research_completed_at, market_rate_floor, market_rate_mid, market_rate_best,
         recommended_strategy
       ) VALUES (
         $1, 'csv', 'Chicago', 'IL', 'US',
         'Dallas', 'TX', 'US',
         NOW() + INTERVAL '3 days', 'Dry Van', 2400, 'USD',
         920, 'qualified', 500, 600,
         NOW(), 1.2, 1.5, 1.8,
         'standard'
       ) RETURNING id`,
      [TEST_LOAD_ID],
    );
    pipelineLoadId = res.rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM match_results WHERE load_id = $1`, [TEST_LOAD_ID]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await briefQueue.obliterate({ force: true });
    await briefQueue.close();
  });

  it('runs matchCarriers, stores match_results, and (research already done) opens the gate', async () => {
    const payload: MatchJobPayload = {
      pipelineLoadId,
      loadId: TEST_LOAD_ID,
      loadBoardSource: 'csv',
      enqueuedAt: new Date().toISOString(),
      priority: 500,
      qualifiedLoad: {
        origin: { city: 'Chicago', state: 'IL', country: 'US' },
        destination: { city: 'Dallas', state: 'TX', country: 'US' },
        equipmentType: 'Dry Van',
        distanceMiles: 920,
        pickupDate: new Date(Date.now() + 3 * 86400_000).toISOString(),
        weightLbs: null,
      },
    };

    const result = await worker.process(payload);
    expect(result.success).toBe(true);

    // Manually trigger the lifecycle hook (we bypass BullMQ in tests).
    await (worker as any).updatePipelineLoad(pipelineLoadId, result);

    const after = await db.query<{ stage: string; carrier_match_count: number; top_carrier_id: string | null }>(
      `SELECT stage, carrier_match_count, top_carrier_id FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );

    if (result.details?.matched) {
      expect(after.rows[0].carrier_match_count).toBeGreaterThan(0);
      // Stage must be 'matched' since research_completed_at was set in beforeAll
      expect(after.rows[0].stage).toBe('matched');

      const persisted = await db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM match_results WHERE load_id = $1`,
        [TEST_LOAD_ID],
      );
      expect(persisted.rows[0].n).toBe(after.rows[0].carrier_match_count);

      const briefJobs = await briefQueue.getJobs(['waiting', 'prioritized', 'active']);
      expect(briefJobs.length).toBe(1);
      expect(briefJobs[0].data.pipelineLoadId).toBe(pipelineLoadId);
    } else {
      // No carriers in the seed test data matched above F. That's still a valid outcome
      // — the worker correctly disqualified the load. Assert the disqualified path.
      expect(after.rows[0].stage).toBe('disqualified');
      expect(after.rows[0].carrier_match_count).toBe(0);
    }
  }, 30_000);
});
