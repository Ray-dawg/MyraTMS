/**
 * FEEDBACK AGENT - LEARNING LOOP
 *
 * Runs post-delivery. Compares predicted outcomes (brief intelligence) against
 * actual outcomes (call results + delivery) and updates the intelligence that makes
 * every upstream agent smarter. This is the compounding engine - after 500 loads,
 * rate predictions improve, persona selection sharpens, carrier scoring becomes
 * more accurate.
 *
 * Activates in two modes:
 * 1. Per-load (event-driven): When a pipeline load reaches 'delivered', enqueue to feedback-queue
 * 2. Nightly aggregation (cron): Daily at 2 AM ET, aggregate 30 days of call data
 *
 * Per-load: Record individual accuracy, update carrier performance, update shipper preferences
 * Nightly: Refresh lane stats, adjust rate targets, update persona metrics, refresh carrier lanes
 */

import { Job } from 'bullmq';
import Redis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

/**
 * Feedback job payload - minimal, just the load ID
 */
export interface FeedbackJobPayload extends BaseJobPayload {
  // The pipelineLoadId is sufficient - fetch everything else from DB
}

/**
 * Feedback worker - learning loop
 */
export class FeedbackWorker extends BaseWorker<FeedbackJobPayload> {
  constructor(redis: Redis) {
    const config: WorkerConfig = {
      queueName: 'feedback-queue',
      expectedStage: 'delivered',
      nextStage: 'scored',
      concurrency: 5, // Lower concurrency - involves multiple DB operations
      retryConfig: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 300000, // 300 seconds (5 minutes) - this is a slow operation
        },
      },
      redis,
    };

    super(config);
  }

  /**
   * Per-load feedback processing
   */
  public async process(payload: FeedbackJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId } = payload;
    logger.debug(`[Feedback] Processing feedback for delivered load ${pipelineLoadId}`);

    try {
      // Fetch pipeline load, call data, brief, and TMS load
      const plResult = await db.query('SELECT * FROM pipeline_loads WHERE id = $1', [pipelineLoadId]);
      const callResult = await db.query(
        'SELECT * FROM agent_calls WHERE pipeline_load_id = $1 AND outcome = $2',
        [pipelineLoadId, 'booked']
      );
      const briefResult = await db.query('SELECT brief FROM negotiation_briefs WHERE pipeline_load_id = $1', [
        pipelineLoadId,
      ]);
      const tmsLoadResult = await db.query('SELECT * FROM loads WHERE id = $1', [
        plResult.rows[0]?.tms_load_id,
      ]);

      const load = plResult.rows[0];
      const call = callResult.rows[0];
      const brief = briefResult.rows[0]?.brief;
      const tmsLoad = tmsLoadResult.rows[0];

      if (!load) {
        logger.warn(`[Feedback] Load ${pipelineLoadId} not found`);
        return {
          success: false,
          pipelineLoadId,
          stage: this.config.expectedStage,
          duration: 0,
          error: 'load_not_found',
        };
      }

      // TODO: Implement per-load feedback processing
      // 1. RATE ACCURACY: Compare predicted market rates vs actual agreed rate
      const predictedMid = load.market_rate_mid;
      const actualAgreed = load.agreed_rate || 0;
      const rateAccuracy = predictedMid > 0 ? 1 - Math.abs(actualAgreed - predictedMid) / predictedMid : null;

      // 2. COST ACCURACY: Compare estimated cost vs actual carrier cost
      // const estimatedCost = brief?.rates?.totalCost;
      // const actualCost = parseFloat(tmsLoad?.carrier_cost || '0');
      // const costAccuracy = estimatedCost > 0 ? 1 - Math.abs(actualCost - estimatedCost) / estimatedCost : null;

      // 3. CARRIER PERFORMANCE: Was the booked carrier on time?
      // const wasOnTime = tmsLoad?.status === 'Delivered'; // Simplified
      // const carrierRating = tmsLoad?.delivery_rating; // If shipper rated

      // 4. PROFIT ACCURACY: Predicted vs actual profit
      // const predictedProfit = load.profit;
      // const actualProfit = parseFloat(tmsLoad?.margin || '0');

      // TODO: Update pipeline_loads to 'scored'
      await db.query(
        `UPDATE pipeline_loads SET stage = 'scored', stage_updated_at = NOW() WHERE id = $1`,
        [pipelineLoadId]
      );

      // TODO: Update carrier performance
      if (call?.retell_call_id && load.top_carrier_id) {
        // Increment load count, update on-time rate
        await db.query(
          `UPDATE carriers SET total_loads = COALESCE(total_loads, 0) + 1, updated_at = NOW() WHERE id = $1`,
          [load.top_carrier_id]
        );
      }

      // TODO: Update shipper preferences
      if (load.shipper_phone && actualAgreed > 0) {
        // Update with new call outcome and agreed rate
        await db.query(
          `INSERT INTO shipper_preferences (phone, total_bookings, avg_agreed_rate, updated_at)
           VALUES ($1, 1, $2, NOW())
           ON CONFLICT (phone) DO UPDATE SET
             total_bookings = shipper_preferences.total_bookings + 1,
             avg_agreed_rate = (COALESCE(avg_agreed_rate, 0) * (total_bookings - 1) + $2) / total_bookings,
             updated_at = NOW()`,
          [load.shipper_phone, actualAgreed]
        );
      }

      // TODO: Feed into quote feedback loop
      // Record actual vs estimated rates for correction factors

      logger.info(
        `[Feedback] Load ${pipelineLoadId} scored. Rate accuracy: ${rateAccuracy ? (rateAccuracy * 100).toFixed(1) : 'N/A'}%`
      );

      return {
        success: true,
        pipelineLoadId,
        stage: this.config.expectedStage,
        duration: 0,
        details: {
          rateAccuracy,
          predictedRate: predictedMid,
          actualRate: actualAgreed,
        },
      };
    } catch (error) {
      logger.error(`[Feedback] Error processing feedback for load ${pipelineLoadId}:`, error);
      throw error;
    }
  }
}

/**
 * Nightly aggregation job - updates learning data from the past 30 days
 * Runs at 2 AM ET via /api/cron/feedback-aggregation
 */
export async function nightlyAggregationJob(): Promise<void> {
  logger.info('[Feedback] Starting nightly aggregation job');

  try {
    // STEP 1: Update lane stats
    await updateLaneStats();

    // STEP 2: Adjust rate targets based on lane performance
    await adjustRateTargets();

    // STEP 3: Update persona performance metrics
    await updatePersonaStats();

    // STEP 4: Trigger carrier lane refresh
    await refreshCarrierLanes();

    logger.info('[Feedback] Nightly aggregation completed successfully');
  } catch (error) {
    logger.error('[Feedback] Error during nightly aggregation:', error);
    // Don't throw - this is a background job
  }
}

/**
 * Update lane_stats table with 30-day aggregated performance
 */
async function updateLaneStats(): Promise<void> {
  // TODO: Implement the SQL from T-11 Section 3.1
  // Aggregate last 30 days of booked calls by lane + persona + time
  // Calculate: avg rates, profit, std dev, booking rate, call duration
  // Insert into lane_stats with ON CONFLICT DO UPDATE

  logger.debug('[Feedback] Lane stats updated');
}

/**
 * Adjust rate targets based on lane performance
 */
async function adjustRateTargets(): Promise<void> {
  // TODO: Implement the logic from T-11 Section 3.2
  // For each lane with 10+ calls:
  //   - If booking_rate < 20% and total_calls >= 20: lower targets (adjustment = -0.05)
  //   - If booking_rate > 60% and avg_profit < $250: raise targets (adjustment = +0.03)
  //   - If booking_rate > 50% and avg_profit > $400: slight increase (adjustment = +0.02)
  // Update lane_stats with rate_adjustment_factor

  logger.debug('[Feedback] Rate targets adjusted');
}

/**
 * Update persona performance metrics for Thompson Sampling
 */
async function updatePersonaStats(): Promise<void> {
  // TODO: Implement the logic from T-11 Section 3.3
  // For each persona, aggregate last 30 days:
  //   - total_calls, total_bookings, avg_profit, total_revenue
  //   - Calculate: booking_rate = bookings / calls
  //   - Update: alpha = bookings + 1, beta = (calls - bookings) + 1
  // Update personas table

  logger.debug('[Feedback] Persona stats updated');
}

/**
 * Trigger carrier lane refresh with latest load data
 */
async function refreshCarrierLanes(): Promise<void> {
  // TODO: Call existing POST /api/matching/refresh-lanes endpoint
  // This rebuilds carrier_lanes from 365 days of load history

  logger.debug('[Feedback] Carrier lanes refreshed');
}

/**
 * Manual feedback submission (if shipper rates the delivery)
 * TODO: Implement optional shipper feedback form
 *
 * export async function submitFeedback(params: {
 *   pipelineLoadId: number;
 *   carrierRating: number; // 1-5
 *   feedback: string;
 *   shipperSatisfaction: number; // 1-5
 * }): Promise<void> {
 *   // Update agent_calls with carrier_rating
 *   // Update loads with delivery_rating
 *   // Enqueue feedback job for that load
 * }
 */

// TODO: Export initialized worker
// export const feedbackWorker = new FeedbackWorker(redisClient);

// TODO: Export cron handler
// export { nightly AggregationJob as feedbackAggregationHandler };
