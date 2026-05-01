/**
 * Researcher (Agent 3) integration test.
 * Inserts a synthetic pipeline_load in 'qualified' stage, runs the worker
 * against live Neon + Upstash, asserts the rate cascade produced a result
 * and that pipeline_loads.market_rate_* + research_completed_at are populated.
 *
 * The test deliberately runs WITHOUT ANTHROPIC_API_KEY so we exercise the
 * benchmark fallback path. With a key set, the test still passes — Claude
 * just contributes as a higher-confidence source.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { ResearcherWorker, type ResearchJobPayload } from '@/lib/workers/researcher-worker';

const TEST_LOAD_ID = `TEST-RES-${Date.now()}`;
const TEST_PHONE = `+15551${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;

describe('ResearcherWorker', () => {
  let pipelineLoadId: number;
  let briefQueue: Queue;
  let worker: ResearcherWorker;

  beforeAll(async () => {
    briefQueue = new Queue('brief-queue-test-res', { connection: redisConnection });
    worker = new ResearcherWorker(redisConnection, briefQueue);

    const res = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, equipment_type,
         posted_rate, posted_rate_currency, distance_miles, distance_km,
         stage, shipper_phone, priority_score
       ) VALUES (
         $1, 'csv', 'Toronto', 'ON', 'CA',
         'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', 'Dry Van',
         2400, 'CAD', 250, 402,
         'qualified', $2, 500
       ) RETURNING id`,
      [TEST_LOAD_ID, TEST_PHONE],
    );
    pipelineLoadId = res.rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await briefQueue.obliterate({ force: true });
    await briefQueue.close();
  });

  it('researches a load, populates market rates, and (ranker not done) holds gate closed', async () => {
    const payload: ResearchJobPayload = {
      pipelineLoadId,
      loadId: TEST_LOAD_ID,
      loadBoardSource: 'csv',
      enqueuedAt: new Date().toISOString(),
      priority: 500,
      qualifiedLoad: {
        origin: { city: 'Toronto', state: 'ON', country: 'CA' },
        destination: { city: 'Sudbury', state: 'ON', country: 'CA' },
        equipmentType: 'Dry Van',
        distanceMiles: 250,
        distanceKm: 402,
        postedRate: 2400,
        postedRateCurrency: 'CAD',
        pickupDate: new Date(Date.now() + 3 * 86400_000).toISOString(),
        deliveryDate: null,
        commodity: null,
        weightLbs: 42000,
      },
      priorityScore: 500,
      estimatedMarginRange: { low: 400, high: 600 },
    };

    const result = await worker.process(payload);
    expect(result.success).toBe(true);

    const intel = result.details?.intelligence;
    expect(intel).toBeTruthy();
    expect(intel.rates.midRate).toBeGreaterThan(0);
    expect(intel.rates.floorRate).toBeLessThanOrEqual(intel.rates.midRate);
    expect(intel.rates.bestRate).toBeGreaterThanOrEqual(intel.rates.midRate);
    expect(intel.rates.sources.length).toBeGreaterThan(0);
    expect(intel.cost.total).toBeGreaterThan(0);
    expect(intel.negotiation.initialOffer).toBeGreaterThan(intel.negotiation.finalOffer);

    await (worker as any).updatePipelineLoad(pipelineLoadId, result);

    const after = await db.query<{
      stage: string;
      market_rate_floor: string | null;
      market_rate_mid: string | null;
      market_rate_best: string | null;
      recommended_strategy: string | null;
      research_completed_at: Date | null;
    }>(
      `SELECT stage, market_rate_floor, market_rate_mid, market_rate_best,
              recommended_strategy, research_completed_at
       FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );

    expect(after.rows[0].research_completed_at).not.toBeNull();
    expect(Number(after.rows[0].market_rate_mid)).toBeGreaterThan(0);
    expect(['aggressive', 'standard', 'walk']).toContain(after.rows[0].recommended_strategy);

    // Ranker has NOT run, so carrier_match_count is null/0 — gate is closed,
    // stage stays 'qualified'.
    expect(after.rows[0].stage).toBe('qualified');
    const briefJobs = await briefQueue.getJobs(['waiting', 'prioritized', 'active']);
    expect(briefJobs.length).toBe(0);
  }, 30_000);
});
