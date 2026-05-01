/**
 * FeedbackWorker integration test (live Neon).
 *
 * Two paths exercised:
 *   1. Per-load: a delivered load with a booked agent_call → α/β increments
 *      on the chosen persona, shipper_preferences upserts with the agreed
 *      rate + best-performing persona, stage flips to 'scored'.
 *   2. Nightly aggregation: 30-day window aggregated into lane_stats and
 *      persona summaries refreshed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { FeedbackWorker, nightlyAggregationJob } from '@/lib/workers/feedback-worker';

const SUFFIX = `${Date.now()}`;
const TEST_LOAD_ID = `TEST-FB-${SUFFIX}`;
const TEST_PHONE = `+15551${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;
const PERSONA_TO_TEST = 'friendly';

describe('FeedbackWorker', () => {
  let pipelineLoadId: number;
  let alphaBefore = 0;
  let betaBefore = 0;

  beforeAll(async () => {
    const ins = await db.query<{ id: number }>(
      `INSERT INTO pipeline_loads (
         load_id, load_board_source, origin_city, origin_state, origin_country,
         destination_city, destination_state, destination_country,
         pickup_date, equipment_type, posted_rate, posted_rate_currency,
         distance_miles, distance_km, shipper_phone, top_carrier_id,
         stage, market_rate_mid, agreed_rate, agreed_rate_currency,
         call_outcome, profit
       ) VALUES (
         $1, 'DAT', 'Toronto', 'ON', 'CA',
         'Sudbury', 'ON', 'CA',
         NOW() + INTERVAL '3 days', 'Dry Van', 2400, 'CAD',
         250, 402, $2, 'car_001',
         'delivered', 2100, 2200, 'CAD',
         'booked', 470
       ) RETURNING id`,
      [TEST_LOAD_ID, TEST_PHONE],
    );
    pipelineLoadId = ins.rows[0].id;

    await db.query(
      `INSERT INTO negotiation_briefs (
         pipeline_load_id, brief, brief_version, persona_selected, strategy,
         initial_offer, target_rate, min_acceptable_rate,
         concession_step_1, concession_step_2, final_offer,
         carrier_count, top_carrier_id, created_at
       ) VALUES ($1, $2, '2.0', $3, 'standard',
                 1216, 1220, 1016, 1150, 1082, 1016, 1, 'car_001', NOW())`,
      [
        pipelineLoadId,
        JSON.stringify({ rates: { totalCost: 1730, currency: 'CAD' } }),
        PERSONA_TO_TEST,
      ],
    );

    await db.query(
      `INSERT INTO agent_calls (
         pipeline_load_id, call_id, call_type, persona, language, currency,
         retell_call_id, retell_agent_id, phone_number_called,
         call_initiated_at, call_ended_at, duration_seconds,
         negotiation_brief_id, initial_offer, min_acceptable_rate, target_rate,
         outcome, agreed_rate, profit, profit_tier, auto_book_eligible,
         sentiment, objections, concessions_made, next_action, created_at
       ) VALUES (
         $1, $2, 'outbound_shipper', $3, 'en', 'CAD',
         $2, 'agent_x', $4,
         NOW() - INTERVAL '1 hour', NOW() - INTERVAL '55 minutes', 280,
         (SELECT id FROM negotiation_briefs WHERE pipeline_load_id = $1 ORDER BY id DESC LIMIT 1),
         1216, 1016, 1220,
         'booked', 2200, 470, 'good', true,
         'positive', '[]', 1, 'send_confirmation', NOW()
       )`,
      [pipelineLoadId, `mock_call_${SUFFIX}`, PERSONA_TO_TEST, TEST_PHONE],
    );

    const persona = await db.query<{ alpha: string; beta: string }>(
      `SELECT alpha, beta FROM personas WHERE persona_name = $1`,
      [PERSONA_TO_TEST],
    );
    alphaBefore = Number(persona.rows[0].alpha);
    betaBefore = Number(persona.rows[0].beta);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM agent_calls WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM negotiation_briefs WHERE pipeline_load_id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    await db.query(`DELETE FROM shipper_preferences WHERE phone = $1`, [TEST_PHONE]);
  });

  it('scores a delivered booked load — increments α, upserts shipper, flips stage', async () => {
    const worker = new FeedbackWorker(redisConnection);
    const result = await worker.process({
      pipelineLoadId,
      loadId: TEST_LOAD_ID,
      loadBoardSource: 'DAT',
      enqueuedAt: new Date().toISOString(),
      priority: 5,
    });

    expect(result.success).toBe(true);
    expect(result.details?.persona).toBe(PERSONA_TO_TEST);
    expect(result.details?.profit).toBe(470);
    // predictedMid=2100, agreedRate=2200 → accuracy ≈ 1 - 100/2100 ≈ 0.952
    expect(result.details?.rateAccuracy).toBeGreaterThan(0.9);

    // α should increment by 1 for a booked outcome (β unchanged)
    const personaAfter = await db.query<{ alpha: string; beta: string; total_calls: number; total_bookings: number }>(
      `SELECT alpha, beta, total_calls, total_bookings FROM personas WHERE persona_name = $1`,
      [PERSONA_TO_TEST],
    );
    expect(Number(personaAfter.rows[0].alpha)).toBeCloseTo(alphaBefore + 1, 5);
    expect(Number(personaAfter.rows[0].beta)).toBeCloseTo(betaBefore, 5);

    // Restore the persona's α to keep the test idempotent across re-runs
    await db.query(
      `UPDATE personas SET alpha = $2, beta = $3,
         total_calls = GREATEST(total_calls - 1, 0),
         total_bookings = GREATEST(total_bookings - 1, 0)
       WHERE persona_name = $1`,
      [PERSONA_TO_TEST, alphaBefore, betaBefore],
    );

    // shipper_preferences was upserted with the agreed rate
    const pref = await db.query<{
      total_calls_received: number;
      total_bookings: number;
      avg_agreed_rate: string;
      best_performing_persona: string;
    }>(
      `SELECT total_calls_received, total_bookings, avg_agreed_rate, best_performing_persona
       FROM shipper_preferences WHERE phone = $1`,
      [TEST_PHONE],
    );
    expect(pref.rows[0].total_calls_received).toBe(1);
    expect(pref.rows[0].total_bookings).toBe(1);
    expect(Number(pref.rows[0].avg_agreed_rate)).toBe(2200);
    expect(pref.rows[0].best_performing_persona).toBe(PERSONA_TO_TEST);

    // Run updatePipelineLoad to flip stage
    await (worker as any).updatePipelineLoad(pipelineLoadId, result);
    const after = await db.query<{ stage: string }>(
      `SELECT stage FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    expect(after.rows[0].stage).toBe('scored');
  }, 30_000);

  it('nightlyAggregationJob runs without errors', async () => {
    // Whatever data is currently in the rolling 30-day window gets aggregated.
    // With only the test seed (or none) the operation should still succeed
    // and return non-negative counts.
    const r = await nightlyAggregationJob();
    expect(r.laneRows).toBeGreaterThanOrEqual(0);
    expect(r.personasUpdated).toBeGreaterThanOrEqual(0);
  }, 30_000);
});
