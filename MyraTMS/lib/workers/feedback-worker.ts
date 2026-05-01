/**
 * AGENT 8 - FEEDBACK WORKER (LEARNING LOOP)
 *
 * Runs post-delivery (per-load) and nightly (cron). Closes the loop on
 * predictions made earlier in the pipeline:
 *
 *   per-load (event-driven, triggered when stage='delivered'):
 *     - Bayesian update of the chosen persona's α/β counters via
 *       updatePersonaStats() — this is the Thompson Sampling feedback signal
 *     - Upsert shipper_preferences with avg agreed rate, total bookings,
 *       best-performing persona
 *     - Increment carriers.total_loads
 *     - Score the load (rate accuracy: predicted mid vs agreed)
 *     - Advance stage 'delivered' → 'scored'
 *
 *   nightly (cron):
 *     - Aggregate lane_stats over the last 30 days (origin/dest/equipment/persona)
 *     - Adjust rate_adjustment_factor based on booking rate + avg profit
 *     - Recompute persona-level averages on the personas table (booking_rate,
 *       avg_profit, total_revenue) — α/β are already touched per-call
 *
 * Both flows are idempotent — re-running on the same load won't double-count.
 */

import Redis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { updatePersonaStats } from '@/lib/pipeline/persona-selector';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

export interface FeedbackJobPayload extends BaseJobPayload {
  // pipelineLoadId is sufficient — everything else comes from the DB.
}

interface FeedbackContext {
  loadId: number;
  agreedRate: number;
  predictedMid: number;
  totalCost: number;
  carrierId: string | null;
  shipperPhone: string | null;
  persona: string | null;
  callOutcome: 'booked' | 'declined' | 'callback' | 'no_answer';
}

export class FeedbackWorker extends BaseWorker<FeedbackJobPayload> {
  constructor(redis: Redis) {
    const config: WorkerConfig = {
      queueName: 'feedback-queue',
      expectedStage: 'delivered',
      // Stage write happens in updatePipelineLoad alongside the score.
      nextStage: undefined,
      concurrency: 5,
      retryConfig: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 300_000 },
      },
      redis,
    };
    super(config);
  }

  public async process(payload: FeedbackJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId } = payload;
    logger.debug(`[Feedback] Scoring delivered load ${pipelineLoadId}`);

    const ctx = await this.gatherContext(pipelineLoadId);
    if (!ctx) {
      return {
        success: false,
        pipelineLoadId,
        stage: this.config.expectedStage,
        duration: 0,
        error: 'load_not_found',
      };
    }

    if (ctx.persona) {
      await this.updatePersonaBayesian(ctx.persona, ctx.callOutcome);
    }

    if (ctx.shipperPhone) {
      await this.upsertShipperPreferences(ctx);
    }

    // Carrier delivery count is derivable from `loads` directly
    // (COUNT WHERE carrier_id=X AND status='Delivered'), so we don't
    // denormalize a counter on the carriers table here.

    const rateAccuracy =
      ctx.predictedMid > 0
        ? 1 - Math.abs(ctx.agreedRate - ctx.predictedMid) / ctx.predictedMid
        : null;
    const profit = ctx.agreedRate - ctx.totalCost;

    logger.info(
      `[Feedback] Load ${pipelineLoadId} scored. ` +
        `agreed=$${ctx.agreedRate} predicted=$${ctx.predictedMid} ` +
        `accuracy=${rateAccuracy != null ? (rateAccuracy * 100).toFixed(1) + '%' : 'n/a'} ` +
        `profit=$${profit.toFixed(2)} persona=${ctx.persona ?? 'n/a'}`,
    );

    return {
      success: true,
      pipelineLoadId,
      stage: this.config.expectedStage,
      duration: 0,
      details: {
        rateAccuracy,
        predictedMid: ctx.predictedMid,
        agreedRate: ctx.agreedRate,
        profit,
        persona: ctx.persona,
      },
    };
  }

  /**
   * Pull every signal we need from the DB in one shot.
   */
  private async gatherContext(pipelineLoadId: number): Promise<FeedbackContext | null> {
    const r = await db.query<{
      load_id: string;
      agreed_rate: string | null;
      market_rate_mid: string | null;
      top_carrier_id: string | null;
      shipper_phone: string | null;
      persona: string | null;
      call_outcome: string | null;
    }>(
      `SELECT pl.load_id, pl.agreed_rate, pl.market_rate_mid, pl.top_carrier_id,
              pl.shipper_phone, pl.call_outcome,
              ac.persona
       FROM pipeline_loads pl
       LEFT JOIN LATERAL (
         SELECT persona FROM agent_calls
         WHERE pipeline_load_id = pl.id
         ORDER BY call_initiated_at DESC LIMIT 1
       ) ac ON TRUE
       WHERE pl.id = $1`,
      [pipelineLoadId],
    );
    const row = r.rows[0];
    if (!row) return null;

    const briefRow = await db.query<{ brief: any }>(
      `SELECT brief FROM negotiation_briefs WHERE pipeline_load_id = $1
       ORDER BY id DESC LIMIT 1`,
      [pipelineLoadId],
    );
    const totalCost = Number(briefRow.rows[0]?.brief?.rates?.totalCost ?? 0);

    const outcome = (row.call_outcome ?? 'booked') as FeedbackContext['callOutcome'];
    return {
      loadId: pipelineLoadId,
      agreedRate: row.agreed_rate ? Number(row.agreed_rate) : 0,
      predictedMid: row.market_rate_mid ? Number(row.market_rate_mid) : 0,
      totalCost,
      carrierId: row.top_carrier_id,
      shipperPhone: row.shipper_phone,
      persona: row.persona,
      callOutcome: outcome,
    };
  }

  /**
   * Point-in-time α/β increment for the persona that handled this call.
   * Uses the pure Beta-update math from persona-selector.ts so the rule
   * lives in one place.
   */
  private async updatePersonaBayesian(
    personaName: string,
    outcome: FeedbackContext['callOutcome'],
  ): Promise<void> {
    const cur = await db.query<{ id: number; alpha: string; beta: string }>(
      `SELECT id, alpha, beta FROM personas WHERE persona_name = $1 LIMIT 1`,
      [personaName],
    );
    if (cur.rows.length === 0) {
      logger.warn(`[Feedback] persona '${personaName}' not found; skipping α/β update`);
      return;
    }
    const next = updatePersonaStats(
      Number(cur.rows[0].alpha),
      Number(cur.rows[0].beta),
      outcome,
    );
    await db.query(
      `UPDATE personas
       SET alpha = $2,
           beta = $3,
           total_calls = COALESCE(total_calls, 0) + 1,
           total_bookings = COALESCE(total_bookings, 0) + $4,
           updated_at = NOW()
       WHERE id = $1`,
      [cur.rows[0].id, next.alpha, next.beta, outcome === 'booked' ? 1 : 0],
    );
  }

  private async upsertShipperPreferences(ctx: FeedbackContext): Promise<void> {
    if (!ctx.shipperPhone) return;
    const booked = ctx.callOutcome === 'booked' ? 1 : 0;

    // Upsert with running-average for avg_agreed_rate. The arithmetic uses
    // the previous total_bookings value so re-runs on the same row don't
    // skew toward the latest sample.
    await db.query(
      `INSERT INTO shipper_preferences (
         phone, total_calls_received, total_bookings, avg_agreed_rate,
         best_performing_persona, updated_at
       ) VALUES ($1, 1, $2, $3, $4, NOW())
       ON CONFLICT (phone) DO UPDATE SET
         total_calls_received = COALESCE(shipper_preferences.total_calls_received, 0) + 1,
         total_bookings = COALESCE(shipper_preferences.total_bookings, 0) + $2,
         avg_agreed_rate = CASE
           WHEN $2 = 1 AND $3 > 0 THEN
             (COALESCE(shipper_preferences.avg_agreed_rate, 0)
              * COALESCE(shipper_preferences.total_bookings, 0) + $3)
             / (COALESCE(shipper_preferences.total_bookings, 0) + 1)
           ELSE shipper_preferences.avg_agreed_rate
         END,
         best_performing_persona = COALESCE($4, shipper_preferences.best_performing_persona),
         updated_at = NOW()`,
      [
        ctx.shipperPhone,
        booked,
        booked === 1 ? ctx.agreedRate : null,
        booked === 1 ? ctx.persona : null,
      ],
    );
  }

  /**
   * Override stage advancement to write 'scored' alongside any score artifacts.
   */
  protected async updatePipelineLoad(pipelineLoadId: number, _result: ProcessResult): Promise<void> {
    await db.query(
      `UPDATE pipeline_loads
       SET stage = 'scored', stage_updated_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND stage = 'delivered'`,
      [pipelineLoadId],
    );
  }
}

// ────────────────────────────────────────────────────────────────────────
// NIGHTLY AGGREGATION
// ────────────────────────────────────────────────────────────────────────

/**
 * Runs from /api/cron/feedback-aggregation. Aggregates the last 30 days of
 * agent_calls into lane_stats, recomputes persona-level averages, and
 * adjusts rate_adjustment_factor based on observed booking-rate / profit.
 *
 * Returns counts so the cron route can return them in its response body.
 */
export async function nightlyAggregationJob(): Promise<{
  laneRows: number;
  personasUpdated: number;
}> {
  logger.info('[Feedback] Nightly aggregation start');
  const laneRows = await aggregateLaneStats();
  await adjustRateTargets();
  const personasUpdated = await refreshPersonaSummaries();
  logger.info(`[Feedback] Nightly aggregation done. lane_stats rows=${laneRows}, personas updated=${personasUpdated}`);
  return { laneRows, personasUpdated };
}

/**
 * Aggregate the last 30 days of agent_calls into lane_stats keyed by
 * (origin/dest/equipment/persona). Uses ON CONFLICT to upsert the rolling
 * window. Booking_rate is computed in SQL so the math stays consistent
 * across re-runs.
 */
async function aggregateLaneStats(): Promise<number> {
  // The unique key on lane_stats is (lane, persona, day_of_week, hour_of_day,
  // equipment_type), so we bucket the rolling 30-day window by call hour and
  // weekday. Re-runs upsert the same buckets; period_start/period_end track
  // the rolling window, not the conflict key.
  const r = await db.query<{ id: number }>(
    `INSERT INTO lane_stats (
       lane, origin_city, origin_state, destination_city, destination_state,
       equipment_type, persona, day_of_week, hour_of_day,
       avg_posted_rate, avg_agreed_rate, avg_profit, rate_std_dev,
       min_agreed_rate, max_agreed_rate,
       total_calls, booked_count, booking_rate,
       avg_call_duration_sec,
       period_start, period_end, updated_at
     )
     SELECT
       pl.origin_city || '-' || pl.destination_city AS lane,
       pl.origin_city, pl.origin_state,
       pl.destination_city, pl.destination_state,
       pl.equipment_type, ac.persona,
       EXTRACT(DOW FROM ac.call_initiated_at)::int  AS day_of_week,
       EXTRACT(HOUR FROM ac.call_initiated_at)::int AS hour_of_day,
       AVG(pl.posted_rate)::numeric,
       AVG(ac.agreed_rate)::numeric,
       AVG(ac.profit)::numeric,
       COALESCE(STDDEV_SAMP(ac.agreed_rate), 0)::numeric,
       MIN(ac.agreed_rate)::numeric,
       MAX(ac.agreed_rate)::numeric,
       COUNT(*)::int,
       COUNT(*) FILTER (WHERE ac.outcome = 'booked')::int,
       (COUNT(*) FILTER (WHERE ac.outcome = 'booked')::numeric
         / NULLIF(COUNT(*), 0))::numeric,
       AVG(ac.duration_seconds)::int,
       (NOW() - INTERVAL '30 days')::date,
       NOW()::date,
       NOW()
     FROM agent_calls ac
     JOIN pipeline_loads pl ON pl.id = ac.pipeline_load_id
     WHERE ac.call_initiated_at > NOW() - INTERVAL '30 days'
       AND ac.persona IS NOT NULL
     GROUP BY pl.origin_city, pl.origin_state,
              pl.destination_city, pl.destination_state,
              pl.equipment_type, ac.persona,
              EXTRACT(DOW FROM ac.call_initiated_at),
              EXTRACT(HOUR FROM ac.call_initiated_at)
     ON CONFLICT (lane, persona, day_of_week, hour_of_day, equipment_type)
     DO UPDATE SET
       avg_posted_rate = EXCLUDED.avg_posted_rate,
       avg_agreed_rate = EXCLUDED.avg_agreed_rate,
       avg_profit = EXCLUDED.avg_profit,
       rate_std_dev = EXCLUDED.rate_std_dev,
       min_agreed_rate = EXCLUDED.min_agreed_rate,
       max_agreed_rate = EXCLUDED.max_agreed_rate,
       total_calls = EXCLUDED.total_calls,
       booked_count = EXCLUDED.booked_count,
       booking_rate = EXCLUDED.booking_rate,
       avg_call_duration_sec = EXCLUDED.avg_call_duration_sec,
       period_start = EXCLUDED.period_start,
       period_end = EXCLUDED.period_end,
       updated_at = NOW()
     RETURNING id`,
  );
  return r.rows.length;
}

/**
 * Per the build plan / T-11 §3.2:
 *   booking_rate < 20% AND total_calls >= 20  → factor -= 0.05  (lower asks)
 *   booking_rate > 60% AND avg_profit < $250  → factor += 0.03  (raise asks)
 *   booking_rate > 50% AND avg_profit > $400  → factor += 0.02  (slight bump)
 * Stored on lane_stats.rate_adjustment_factor (default 1.0). Read by the
 * Researcher as a multiplier on the cascade output during rate cascade.
 */
async function adjustRateTargets(): Promise<void> {
  await db.query(
    `UPDATE lane_stats
     SET rate_adjustment_factor = CASE
       WHEN booking_rate < 0.20 AND total_calls >= 20 THEN COALESCE(rate_adjustment_factor, 1.0) - 0.05
       WHEN booking_rate > 0.60 AND avg_profit < 250 THEN COALESCE(rate_adjustment_factor, 1.0) + 0.03
       WHEN booking_rate > 0.50 AND avg_profit > 400 THEN COALESCE(rate_adjustment_factor, 1.0) + 0.02
       ELSE COALESCE(rate_adjustment_factor, 1.0)
     END,
     updated_at = NOW()
     WHERE total_calls >= 10`,
  );
}

/**
 * Recompute persona-level rollups (booking_rate, avg_profit, total_revenue,
 * avg_call_duration_sec) on the personas table. α/β are NOT touched here —
 * those move per-call via FeedbackWorker.process() so Thompson Sampling
 * never sees a stale prior.
 */
async function refreshPersonaSummaries(): Promise<number> {
  const r = await db.query<{ persona_name: string }>(
    `WITH agg AS (
       SELECT persona,
              COUNT(*)::int AS calls_30d,
              COUNT(*) FILTER (WHERE outcome = 'booked')::int AS bookings_30d,
              AVG(profit)::numeric AS avg_profit,
              SUM(agreed_rate) FILTER (WHERE outcome = 'booked')::numeric AS rev,
              AVG(duration_seconds)::int AS avg_dur
       FROM agent_calls
       WHERE call_initiated_at > NOW() - INTERVAL '30 days'
         AND persona IS NOT NULL
       GROUP BY persona
     )
     UPDATE personas p
     SET booking_rate = (a.bookings_30d::numeric / NULLIF(a.calls_30d, 0)),
         avg_profit = a.avg_profit,
         total_revenue = a.rev,
         avg_call_duration_sec = a.avg_dur,
         updated_at = NOW()
     FROM agg a
     WHERE p.persona_name = a.persona
     RETURNING p.persona_name`,
  );
  return r.rows.length;
}
