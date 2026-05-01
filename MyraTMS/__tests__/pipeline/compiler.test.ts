/**
 * Compiler (Agent 5) integration test.
 * Inserts a synthetic pipeline_load in 'matched' stage with research data
 * already populated, plus a match_results row pointing at a real carrier.
 * Runs the worker, then asserts:
 *   - A negotiation_briefs row was inserted
 *   - The persisted brief validates (validateBrief returns valid: true)
 *   - compileRetellPayload() output is structurally correct
 *   - Every dynamic_variable is a string (Retell API requirement)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { CompilerWorker, type BriefJobPayload } from '@/lib/workers/compiler-worker';
import { validateBrief } from '@/lib/pipeline/negotiation-brief';

const TEST_LOAD_ID = `TEST-CMP-${Date.now()}`;
const TEST_PHONE = `+15551${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;
const REAL_CARRIER_ID = 'car_001'; // FastHaul Logistics, Active, has contact_phone

describe('CompilerWorker', () => {
  let pipelineLoadId: number;
  let callQueue: Queue;
  let worker: CompilerWorker;
  let createdBriefId: number | null = null;

  beforeAll(async () => {
    callQueue = new Queue('call-queue-test-cmp', { connection: redisConnection });
    worker = new CompilerWorker(redisConnection, callQueue);

    // Insert pipeline_load in 'matched' stage with research data already populated.
    const res = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, delivery_date, equipment_type, commodity, weight_lbs,
         distance_miles, distance_km, posted_rate, posted_rate_currency,
         shipper_company, shipper_contact_name, shipper_phone, shipper_email,
         stage, priority_score, estimated_margin_high,
         research_completed_at, market_rate_floor, market_rate_mid, market_rate_best,
         recommended_strategy, carrier_match_count, top_carrier_id
       ) VALUES (
         $1, 'DAT', 'Toronto', 'ON', 'CA',
         'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 'general freight', 42000,
         250, 402, 2400, 'CAD',
         'Northern Mine Supply Co', 'Jean-Marc Tremblay', $2, 'jm@nmsco.ca',
         'matched', 500, 600,
         NOW(), 1700, 2100, 2500,
         'standard', 1, $3
       ) RETURNING id`,
      [TEST_LOAD_ID, TEST_PHONE, REAL_CARRIER_ID],
    );
    pipelineLoadId = res.rows[0].id;

    // Insert one match_results row. Use an explicit id with millisecond +
    // random suffix because the default PK ('MR-' || hex(epoch_seconds))
    // collides when multiple tests run in parallel within the same second.
    await db.query(
      `INSERT INTO match_results (
         id, load_id, carrier_id, match_score, match_grade, breakdown, was_selected, assignment_method, created_at
       ) VALUES ($1, $2, $3, 0.78, 'B', $4, false, 'auto', NOW())`,
      [
        `MR-CMP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        TEST_LOAD_ID,
        REAL_CARRIER_ID,
        JSON.stringify({
          equipment: { match: true, score: 1 },
          lane_familiarity: { loads_on_lane: 2, score: 0.6 },
          proximity: { miles_from_origin: null, score: 0.5 },
          rate: { carrier_avg_rate: 1850, score: 0.85 },
          reliability: { on_time_pct: 93, score: 0.93 },
          relationship: { last_load_days_ago: 30, score: 0.6 },
        }),
      ],
    );
  });

  afterAll(async () => {
    if (createdBriefId) {
      await db.query(`DELETE FROM negotiation_briefs WHERE id = $1`, [createdBriefId]);
    }
    await db.query(`DELETE FROM match_results WHERE load_id = $1`, [TEST_LOAD_ID]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await callQueue.obliterate({ force: true });
    await callQueue.close();
  });

  it('compiles a complete brief, persists it, and produces a Retell-ready payload', async () => {
    // Pin clock to mid-day so calling-hours validation passes regardless of when
    // the suite is run. We use `now` so date-dependent SQL above (pickup_date,
    // delivery_date) keeps the same offsets it had at insert time.
    const noon = new Date();
    noon.setHours(14, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(noon);

    try {
      const payload: BriefJobPayload = {
        pipelineLoadId,
        loadId: TEST_LOAD_ID,
        loadBoardSource: 'DAT',
        enqueuedAt: new Date().toISOString(),
        priority: 500,
      };

      const result = await worker.process(payload);
      expect(result.success).toBe(true);

      const briefId = result.details?.briefId;
      expect(briefId).toBeGreaterThan(0);
      createdBriefId = briefId;

      const persisted = await db.query<{ brief: any; persona_selected: string; strategy: string }>(
        `SELECT brief, persona_selected, strategy FROM negotiation_briefs WHERE id = $1`,
        [briefId],
      );
      expect(persisted.rows.length).toBe(1);
      expect(['assertive', 'friendly', 'analytical']).toContain(persisted.rows[0].persona_selected);
      expect(['aggressive', 'standard', 'walk']).toContain(persisted.rows[0].strategy);

      const persistedBrief = persisted.rows[0].brief;
      const revalidation = validateBrief(persistedBrief);
      expect(revalidation.valid).toBe(true);
      expect(revalidation.errors).toEqual([]);

      const retellPayload = result.details?.retellPayload;
      expect(retellPayload).toBeTruthy();
      expect(retellPayload.from_number).toMatch(/^\+1\d{10}$/);
      expect(retellPayload.to_number).toBe(TEST_PHONE);
      expect(retellPayload.agent_id).toBeTruthy();
      expect(typeof retellPayload.metadata).toBe('object');
      expect(retellPayload.metadata.pipelineLoadId).toBe(pipelineLoadId);
      expect(retellPayload.metadata.briefId).toBe(briefId);

      // CRITICAL: every dynamic_variable must be a string (Retell API requirement).
      const dynVars = retellPayload.retell_llm_dynamic_variables;
      for (const [key, value] of Object.entries(dynVars)) {
        expect(typeof value, `dynamic_variables.${key} must be a string, got ${typeof value}`).toBe('string');
      }

      expect(dynVars.pickup_city).toBe('Toronto');
      expect(dynVars.delivery_city).toBe('Sudbury');
      expect(dynVars.equipment_type).toBe('dry van');
      expect(dynVars.currency).toBe('CAD');
      expect(Number(dynVars.initial_rate)).toBeGreaterThan(Number(dynVars.final_offer));
      expect(Number(dynVars.final_offer)).toBeGreaterThan(0);

      expect(persistedBrief.carriers.length).toBeGreaterThanOrEqual(1);
      expect(persistedBrief.carriers[0].carrierId).toBe(REAL_CARRIER_ID);

      // Verify objection playbook is fully loaded (9 entries).
      expect(persistedBrief.objectionPlaybook.length).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
