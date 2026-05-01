/**
 * AGENT 2 - QUALIFIER WORKER
 *
 * The kill switch. Evaluates every scanned load against a filter chain.
 * If all filters pass, load is qualified and enqueued to both research-queue (Agent 3)
 * and match-queue (Agent 4) for parallel processing.
 * If any filter fails, load is disqualified immediately (dead end).
 *
 * Input: qualify-queue with QualifyJobPayload
 * Output: Load stage advanced to 'qualified' or 'disqualified'
 * Next Stages: research-queue + match-queue (parallel) OR dead end
 *
 * No AI required. Pure SQL queries and deterministic logic.
 * Filter chain (in order): freshness → equipment match → lane coverage → margin viability → DNC → shipper fatigue
 */

import { Job } from 'bullmq';
import Redis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

/**
 * Qualifier job payload - received from Agent 1 (Scanner)
 */
export interface QualifyJobPayload extends BaseJobPayload {
  origin: { city: string; state: string; country: string };
  destination: { city: string; state: string; country: string };
  equipmentType: string;
  postedRate: number | null;
  postedRateCurrency: string;
  distanceMiles: number;
  pickupDate: string;
  shipperPhone: string | null;
}

/**
 * Qualification result - used internally and for logging
 */
interface QualificationResult {
  passed: boolean;
  reason: string;
  priorityScore: number;
  estimatedMarginLow: number;
  estimatedMarginHigh: number;
  carrierMatchCount: number;
}

/**
 * Qualifier worker - filters loads to eliminate unprofitable ones early
 */
export class QualifierWorker extends BaseWorker<QualifyJobPayload> {
  private researchQueue: any; // TODO: Import Queue type properly
  private matchQueue: any;

  constructor(redis: Redis, researchQueue: any, matchQueue: any) {
    const config: WorkerConfig = {
      queueName: 'qualify-queue',
      expectedStage: 'scanned',
      nextStage: 'qualified', // Will be set conditionally
      concurrency: 50, // High concurrency - pure SQL/logic, very fast
      retryConfig: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 30000, // 30 seconds
        },
      },
      redis,
    };

    super(config);
    this.researchQueue = researchQueue;
    this.matchQueue = matchQueue;
  }

  /**
   * Main qualification logic
   * Implements the filter chain from T-05
   */
  public async process(payload: QualifyJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId } = payload;
    logger.debug(`[Qualifier] Processing load ${pipelineLoadId}`);

    try {
      const qualResult = await this.qualifyLoad(payload);

      if (qualResult.passed) {
        // All filters passed - enqueue to parallel research and matching
        logger.info(
          `[Qualifier] Load ${pipelineLoadId} qualified. Priority: ${qualResult.priorityScore}, Margin: $${qualResult.estimatedMarginLow}-$${qualResult.estimatedMarginHigh}`
        );

        // TODO: Build research and match payloads from qualifier result
        // and enqueue to both queues
        // const researchPayload = this.buildResearchPayload(payload, qualResult);
        // const matchPayload = this.buildMatchPayload(payload);
        // await this.researchQueue.add('research', researchPayload, { priority: qualResult.priorityScore });
        // await this.matchQueue.add('match', matchPayload, { priority: qualResult.priorityScore });

        return {
          success: true,
          pipelineLoadId,
          stage: this.config.expectedStage,
          nextStage: 'qualified',
          duration: 0,
          details: {
            passed: true,
            priorityScore: qualResult.priorityScore,
            estimatedMargin: {
              low: qualResult.estimatedMarginLow,
              high: qualResult.estimatedMarginHigh,
            },
            carrierMatchCount: qualResult.carrierMatchCount,
          },
        };
      } else {
        // Filter failed - disqualify the load
        logger.info(`[Qualifier] Load ${pipelineLoadId} disqualified: ${qualResult.reason}`);

        // TODO: Update stage to 'disqualified' with reason
        // This is a special case - overrides the normal nextStage update
        // await db.query(
        //   `UPDATE pipeline_loads SET
        //     stage = 'disqualified',
        //     stage_updated_at = NOW(),
        //     qualification_reason = $2
        //    WHERE id = $1`,
        //   [pipelineLoadId, qualResult.reason]
        // );

        return {
          success: true,
          pipelineLoadId,
          stage: this.config.expectedStage,
          duration: 0,
          details: {
            passed: false,
            reason: qualResult.reason,
          },
        };
      }
    } catch (error) {
      logger.error(`[Qualifier] Error processing load ${pipelineLoadId}:`, error);
      throw error;
    }
  }

  /**
   * Run the complete qualification filter chain
   * Returns immediately on first failure
   */
  private async qualifyLoad(payload: QualifyJobPayload): Promise<QualificationResult> {
    // FILTER 1: Freshness check (< 1ms)
    // Kill loads with pickup date in the past or within 4 hours
    const pickupTime = new Date(payload.pickupDate).getTime();
    const nowPlusFourHours = Date.now() + 4 * 3600000;

    if (pickupTime < nowPlusFourHours) {
      return {
        passed: false,
        reason: 'Pickup date is less than 4 hours away or in the past',
        priorityScore: 0,
        estimatedMarginLow: 0,
        estimatedMarginHigh: 0,
        carrierMatchCount: 0,
      };
    }

    // FILTER 2: Equipment match (1 SQL query, ~5ms)
    // Do we have ANY carrier with this equipment type?
    // TODO: Normalize equipment type for TMS
    // const normalizedEquipment = normalizeEquipmentForTMS(payload.equipmentType);

    const equipMatch = await db.query(
      `SELECT COUNT(DISTINCT ce.carrier_id) as count
       FROM carrier_equipment ce
       JOIN carriers c ON ce.carrier_id = c.id
       WHERE ce.equipment_type = $1
         AND c.status = 'Active'
         AND c.authority_status IN ('Active', 'Verified')
         AND c.insurance_status = 'Valid'`,
      [payload.equipmentType]
    );

    if (parseInt(equipMatch.rows[0].count) === 0) {
      return {
        passed: false,
        reason: `No active carriers with ${payload.equipmentType} equipment`,
        priorityScore: 0,
        estimatedMarginLow: 0,
        estimatedMarginHigh: 0,
        carrierMatchCount: 0,
      };
    }

    // FILTER 3: Lane coverage (1 SQL query, ~10ms)
    // Do we have any carrier that runs near this origin?
    // TODO: Implement region mapper from quoting engine
    // const originRegion = resolveRegion(payload.origin.city, payload.origin.state);
    // const destRegion = resolveRegion(payload.destination.city, payload.destination.state);

    const laneMatch = await db.query(
      `SELECT COUNT(DISTINCT cl.carrier_id) as count
       FROM carrier_lanes cl
       JOIN carriers c ON cl.carrier_id = c.id
       WHERE c.status = 'Active'`,
      []
    );

    const carrierMatchCount = parseInt(laneMatch.rows[0].count);

    // FILTER 4: Minimum rate viability (calculation, ~1ms)
    // Use benchmark rates to estimate if margin is possible
    // TODO: Implement benchmark rate lookup from quoting engine
    // const benchmarkRate = getBenchmarkRate(payload.distanceMiles, payload.equipmentType);
    // const estimatedCost = estimateCarrierCost(payload.distanceMiles, payload.origin.country);

    const distanceKm = payload.distanceMiles * 1.60934;
    const estimatedCost = this.estimateCarrierCost(payload.distanceMiles, payload.origin.country);
    const postedRate = payload.postedRate || 2500; // Fallback to average
    const estimatedMarginHigh = postedRate - estimatedCost;
    const estimatedMarginLow = estimatedMarginHigh * 0.7; // Conservative

    const minMargin = payload.origin.country === 'CA' ? 270 : 200;

    if (estimatedMarginHigh < minMargin * 0.5) {
      return {
        passed: false,
        reason: `Best-case margin $${estimatedMarginHigh.toFixed(0)} < 50% of minimum $${minMargin}`,
        priorityScore: 0,
        estimatedMarginLow: 0,
        estimatedMarginHigh: 0,
        carrierMatchCount: 0,
      };
    }

    // FILTER 5: DNC check (~2ms Redis or DB lookup)
    if (payload.shipperPhone) {
      const isDNC = await db.query('SELECT 1 FROM dnc_list WHERE phone = $1', [
        payload.shipperPhone,
      ]);

      if (isDNC.rows.length > 0) {
        return {
          passed: false,
          reason: 'Shipper phone is on do-not-call list',
          priorityScore: 0,
          estimatedMarginLow: 0,
          estimatedMarginHigh: 0,
          carrierMatchCount: 0,
        };
      }
    }

    // FILTER 6: Shipper fatigue check (~3ms)
    if (payload.shipperPhone) {
      // TODO: Implement fatigue check from shipper_preferences or agent_calls history
      // const fatigue = await checkShipperFatigue(payload.shipperPhone);
      // if (!fatigue.canContact) {
      //   return { passed: false, reason: fatigue.reason, ... };
      // }
    }

    // ALL FILTERS PASSED - compute priority score
    const priorityScore = this.computePriorityScore({
      estimatedMargin: estimatedMarginHigh,
      carrierMatchCount,
      hasPostedRate: payload.postedRate !== null,
      daysUntilPickup: this.daysBetween(new Date(), new Date(payload.pickupDate)),
      isRepeatShipper: false, // TODO: Check shipper_preferences
    });

    return {
      passed: true,
      reason: 'All filters passed',
      priorityScore,
      estimatedMarginLow,
      estimatedMarginHigh,
      carrierMatchCount,
    };
  }

  /**
   * Compute priority score (0-1000) for ordering loads downstream
   * Higher score = higher priority
   */
  private computePriorityScore(params: {
    estimatedMargin: number;
    carrierMatchCount: number;
    hasPostedRate: boolean;
    daysUntilPickup: number;
    isRepeatShipper: boolean;
  }): number {
    let score = 0;

    // Margin potential (0-400 points)
    score += Math.min(Math.round(params.estimatedMargin * 0.8), 400);

    // Carrier coverage (0-200 points)
    score += Math.min(params.carrierMatchCount * 40, 200);

    // Posted rate certainty (0-150 points)
    score += params.hasPostedRate ? 150 : 0;

    // Urgency (0-150 points)
    if (params.daysUntilPickup <= 1) score += 150;
    else if (params.daysUntilPickup <= 3) score += 100;
    else if (params.daysUntilPickup <= 7) score += 50;

    // Repeat shipper bonus (0-100 points)
    score += params.isRepeatShipper ? 100 : 0;

    return Math.min(score, 1000);
  }

  /**
   * Estimate carrier cost for this load
   */
  private estimateCarrierCost(distanceMiles: number, country: string): number {
    const costPerMile = country === 'CA' ? 2.0 : 1.5;
    const totalMiles = distanceMiles * 1.15; // 15% deadhead factor
    return totalMiles * costPerMile + 62.5 + 75 + 35; // fuel + accessorials + admin
  }

  /**
   * Calculate days between two dates
   */
  private daysBetween(date1: Date, date2: Date): number {
    const millisecondsPerDay = 1000 * 60 * 60 * 24;
    return Math.floor((date2.getTime() - date1.getTime()) / millisecondsPerDay);
  }

  /**
   * Override updatePipelineLoad to handle conditional stage advancement
   * Qualified loads go to 'qualified', disqualified go to 'disqualified'
   */
  protected async updatePipelineLoad(pipelineLoadId: number, result: any): Promise<void> {
    try {
      if (result.details.passed) {
        // Qualified - also store margin estimates and priority
        await db.query(
          `UPDATE pipeline_loads
           SET stage = 'qualified',
               stage_updated_at = NOW(),
               has_carrier_match = true,
               estimated_margin_low = $2,
               estimated_margin_high = $3,
               priority_score = $4,
               carrier_match_count = $5,
               updated_at = NOW()
           WHERE id = $1`,
          [
            pipelineLoadId,
            result.details.estimatedMargin.low,
            result.details.estimatedMargin.high,
            result.details.priorityScore,
            result.details.carrierMatchCount,
          ]
        );
      } else {
        // Disqualified
        await db.query(
          `UPDATE pipeline_loads
           SET stage = 'disqualified',
               stage_updated_at = NOW(),
               qualification_reason = $2,
               updated_at = NOW()
           WHERE id = $1`,
          [pipelineLoadId, result.details.reason]
        );
      }

      logger.debug(
        `[Qualifier] Pipeline load ${pipelineLoadId} advanced to stage: ${result.details.passed ? 'qualified' : 'disqualified'}`
      );
    } catch (error) {
      logger.error(`[Qualifier] Failed to update pipeline load ${pipelineLoadId}:`, error);
      throw error;
    }
  }
}

// TODO: Export initialized worker
// export const qualifierWorker = new QualifierWorker(redisClient, researchQueue, matchQueue);
