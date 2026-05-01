/**
 * AGENT 4 - CARRIER RANKER WORKER
 *
 * Takes a qualified load and returns the top 3 carriers ranked by match score.
 * Wraps the existing 5-criteria matching engine as a standalone pipeline worker.
 * Runs in PARALLEL with Agent 3 (Researcher).
 *
 * Input: match-queue with MatchJobPayload
 * Output: Carrier stack written to pipeline_loads, carrier_match_count set
 * Next Stage: matched (only after Agent 3 also completes - completion gate)
 *
 * This agent is ~85% built. The matching engine exists and works.
 * The gap is extracting it from TMS API into a pipeline worker and adding the gate check.
 */

import { Job } from 'bullmq';
import Redis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

/**
 * Ranker job payload - received from Agent 2 (Qualifier)
 */
export interface MatchJobPayload extends BaseJobPayload {
  qualifiedLoad: {
    origin: { city: string; state: string; country: string };
    destination: { city: string; state: string; country: string };
    equipmentType: string;
    distanceMiles: number;
    pickupDate: string;
    weightLbs: number | null;
  };
}

/**
 * Carrier stack entry - one carrier in the matched stack
 */
interface CarrierStackEntry {
  carrierId: string;
  companyName: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;

  // Match scoring
  matchScore: number; // 0-1 from matching engine
  matchGrade: string; // 'A' | 'B' | 'C' | 'D' | 'F'
  breakdown: {
    laneFamiliarity: number;
    proximity: number;
    rate: number;
    reliability: number;
    relationship: number;
  };

  // Rate
  expectedRate: number;
  rateCurrency: string;

  // Reliability data
  onTimePercentage: number | null;
  communicationRating: number | null;
  totalLoadsWithMyra: number;
  veteranStatus: string; // 'NEW' | 'PROVEN' | 'VETERAN'

  // Availability
  availabilityConfidence: 'high' | 'medium' | 'low';
  equipmentConfirmed: boolean;
  homeBaseCity: string;
  homeBaseState: string;
  estimatedDeadheadMiles: number | null;

  // Preferences
  paymentPreference: string;
  preferredContactMethod: string;
}

type CarrierStack = CarrierStackEntry[];

/**
 * Ranker worker - carrier matching and ranking
 */
export class RankerWorker extends BaseWorker<MatchJobPayload> {
  private briefQueue: any; // TODO: Import Queue type

  constructor(redis: Redis, briefQueue: any) {
    const config: WorkerConfig = {
      queueName: 'match-queue',
      expectedStage: 'qualified',
      nextStage: 'matched', // Set conditionally by completion gate
      concurrency: 20, // Fast - mostly DB queries
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
    this.briefQueue = briefQueue;
  }

  /**
   * Main matching logic
   */
  public async process(payload: MatchJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId, qualifiedLoad } = payload;
    logger.debug(`[Ranker] Processing load ${pipelineLoadId}`);

    try {
      // TODO: Call the existing matching engine from lib/matching/
      // const matchResults = await runMatchingEngine(qualifiedLoad);
      // Get top 3 matches

      const carrierStack: CarrierStack = []; // TODO: Build from matching results

      if (carrierStack.length === 0) {
        // No viable carriers - disqualify the load
        logger.warn(`[Ranker] Load ${pipelineLoadId} has no matching carriers. Disqualifying.`);

        // TODO: Update stage to 'disqualified'
        // This is a special case - the load fails at matching

        return {
          success: true,
          pipelineLoadId,
          stage: this.config.expectedStage,
          duration: 0,
          details: {
            matched: false,
            reason: 'No carriers matched above F grade',
            carrierCount: 0,
          },
        };
      }

      logger.info(
        `[Ranker] Load ${pipelineLoadId} matched with ${carrierStack.length} carriers. Top: ${carrierStack[0].companyName} (${carrierStack[0].matchGrade})`
      );

      return {
        success: true,
        pipelineLoadId,
        stage: this.config.expectedStage,
        duration: 0,
        details: {
          matched: true,
          carrierCount: carrierStack.length,
          topGrade: carrierStack[0].matchGrade,
          carrierStack,
        },
      };
    } catch (error) {
      logger.error(`[Ranker] Error processing load ${pipelineLoadId}:`, error);
      throw error;
    }
  }

  /**
   * Run the existing matching engine and build the carrier stack
   */
  private async runMatching(pipelineLoadId: number, qualifiedLoad: any): Promise<CarrierStack> {
    // TODO: Implement carrier matching
    // Steps:
    // 1. Call existing runMatchingEngine(qualifiedLoad) from lib/matching/
    // 2. Filter results to exclude F-grade matches
    // 3. Take top 3 results
    // 4. For each match:
    //    a. Query carriers table for full carrier data
    //    b. Query carrier_lanes for lane history
    //    c. Query location_pings for proximity data
    //    d. Build CarrierStackEntry with all fields populated
    // 5. Store in match_results table (existing pattern)
    // 6. Return the carrier stack

    return [];
  }

  /**
   * Determine availability confidence for a carrier
   */
  private determineAvailability(carrier: any, load: any): 'high' | 'medium' | 'low' {
    // High: carrier has GPS ping within 24h near origin AND confirmed equipment
    // Medium: carrier has home base in region OR has run this lane in last 30 days
    // Low: carrier matches on equipment only, no proximity or recency data

    // TODO: Implement availability check logic

    return 'medium';
  }

  /**
   * Override updatePipelineLoad to handle carrier stack storage and completion gate
   */
  protected async updatePipelineLoad(pipelineLoadId: number, result: any): Promise<void> {
    try {
      const { matched, carrierCount, carrierStack } = result.details;

      if (!matched) {
        // No viable carriers - disqualify
        await db.query(
          `UPDATE pipeline_loads
           SET carrier_match_count = 0,
               stage = 'disqualified',
               stage_updated_at = NOW(),
               qualification_reason = 'No carriers matched above F grade',
               updated_at = NOW()
           WHERE id = $1`,
          [pipelineLoadId]
        );

        logger.debug(`[Ranker] Load ${pipelineLoadId} disqualified - no carrier matches`);
        return;
      }

      // Store carrier stack and match results
      await db.query(
        `UPDATE pipeline_loads
         SET carrier_match_count = $2,
             top_carrier_id = $3,
             updated_at = NOW()
         WHERE id = $1`,
        [
          pipelineLoadId,
          carrierStack.length,
          parseInt(carrierStack[0].carrierId.replace('CAR-', '')),
        ]
      );

      // TODO: Store match results in match_results table (existing pattern)
      // for (const match of carrierStack) {
      //   await db.query(`
      //     INSERT INTO match_results (id, load_id, carrier_id, match_score, match_grade, breakdown, created_at)
      //     VALUES ($1, $2, $3, $4, $5, $6, NOW())
      //   `, [generateId('MR'), pipelineLoadId.toString(), match.carrierId, ...]);
      // }

      // COMPLETION GATE: Check if Agent 3 (Researcher) is also done
      const check = await db.query(
        'SELECT research_completed_at FROM pipeline_loads WHERE id = $1',
        [pipelineLoadId]
      );

      if (check.rows[0]?.research_completed_at) {
        // Both agents done - advance to 'matched'
        await db.query(
          "UPDATE pipeline_loads SET stage = 'matched', stage_updated_at = NOW() WHERE id = $1",
          [pipelineLoadId]
        );

        // TODO: Enqueue to brief-queue
        // const briefPayload = this.buildBriefPayload(pipelineLoadId, result);
        // await this.briefQueue.add('brief', briefPayload, { priority: ... });

        logger.info(
          `[Ranker] Completion gate triggered. Load ${pipelineLoadId} advanced to 'matched' and enqueued to brief-queue.`
        );
      } else {
        logger.debug(
          `[Ranker] Agent 3 not yet done. Load ${pipelineLoadId} waiting for research to complete.`
        );
      }
    } catch (error) {
      logger.error(`[Ranker] Failed to update pipeline load ${pipelineLoadId}:`, error);
      throw error;
    }
  }
}

// TODO: Export initialized worker
// export const rankerWorker = new RankerWorker(redisClient, briefQueue);

// TODO: Import and use existing matching engine
// import { runMatchingEngine } from '@/lib/matching';
