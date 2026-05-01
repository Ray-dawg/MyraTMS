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
 * Filter chain (in order): freshness → equipment match → lane coverage →
 *                          margin viability → DNC → shipper fatigue
 */

import { Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { extractRegion } from '@/lib/matching/regions';
import { getBenchmarkRate } from '@/lib/quoting/rates/benchmark';
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
  isRepeatShipper: boolean;
}

/**
 * Normalize free-form equipment strings to the values stored in
 * carrier_equipment.equipment_type. Mirrors lib/matching/filters.ts so
 * Agent 2's eligibility check matches Agent 4's later eligibility check.
 */
function normalizeEquipment(equip: string): string {
  const lower = (equip || '').toLowerCase().trim();
  if (lower.includes('reefer') || lower.includes('refriger')) return 'Reefer';
  if (lower.includes('flat')) return 'Flatbed';
  if (lower.includes('step')) return 'Step Deck';
  return 'Dry Van';
}

/**
 * Format an origin/destination into the "City, ST" string the matching engine
 * and quoting engine expect.
 */
function formatLocation(loc: { city: string; state: string }): string {
  return `${loc.city}, ${loc.state}`;
}

/**
 * Qualifier worker - filters loads to eliminate unprofitable ones early
 */
export class QualifierWorker extends BaseWorker<QualifyJobPayload> {
  private researchQueue: Queue;
  private matchQueue: Queue;

  constructor(redis: Redis, researchQueue: Queue, matchQueue: Queue) {
    const config: WorkerConfig = {
      queueName: 'qualify-queue',
      expectedStage: 'scanned',
      nextStage: 'qualified',
      concurrency: 50, // pure SQL, very fast
      retryConfig: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30000 },
      },
      redis,
    };

    super(config);
    this.researchQueue = researchQueue;
    this.matchQueue = matchQueue;
  }

  /**
   * Main qualification logic. Implements the filter chain from T-05.
   */
  public async process(payload: QualifyJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId } = payload;
    logger.debug(`[Qualifier] Processing load ${pipelineLoadId}`);

    const qualResult = await this.qualifyLoad(payload);

    if (qualResult.passed) {
      logger.info(`[Qualifier] Load ${pipelineLoadId} qualified`, {
        priority: qualResult.priorityScore,
        marginLow: qualResult.estimatedMarginLow,
        marginHigh: qualResult.estimatedMarginHigh,
        carriers: qualResult.carrierMatchCount,
      });

      // Fan out to Agent 3 (research) and Agent 4 (match) in parallel.
      // Both jobs read pipeline_loads — qualifier's updatePipelineLoad will
      // run AFTER process() returns, so we don't pre-update here.
      const fanoutPayload = {
        pipelineLoadId,
        loadId: payload.loadId,
        loadBoardSource: payload.loadBoardSource,
        enqueuedAt: new Date().toISOString(),
        priority: qualResult.priorityScore,
      };

      await Promise.all([
        this.researchQueue.add('research', {
          ...fanoutPayload,
          qualifiedLoad: {
            origin: payload.origin,
            destination: payload.destination,
            equipmentType: payload.equipmentType,
            distanceMiles: payload.distanceMiles,
            pickupDate: payload.pickupDate,
            shipperPhone: payload.shipperPhone,
            postedRate: payload.postedRate,
            postedRateCurrency: payload.postedRateCurrency,
          },
        }, { priority: qualResult.priorityScore }),
        this.matchQueue.add('match', {
          ...fanoutPayload,
          qualifiedLoad: {
            origin: payload.origin,
            destination: payload.destination,
            equipmentType: payload.equipmentType,
            distanceMiles: payload.distanceMiles,
            pickupDate: payload.pickupDate,
            weightLbs: null,
          },
        }, { priority: qualResult.priorityScore }),
      ]);

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
          isRepeatShipper: qualResult.isRepeatShipper,
        },
      };
    }

    // Disqualified branch — updatePipelineLoad will set stage='disqualified'
    logger.info(`[Qualifier] Load ${pipelineLoadId} disqualified: ${qualResult.reason}`);
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

  /**
   * Run the complete qualification filter chain.
   * Returns immediately on first failure.
   */
  private async qualifyLoad(payload: QualifyJobPayload): Promise<QualificationResult> {
    const fail = (reason: string): QualificationResult => ({
      passed: false,
      reason,
      priorityScore: 0,
      estimatedMarginLow: 0,
      estimatedMarginHigh: 0,
      carrierMatchCount: 0,
      isRepeatShipper: false,
    });

    // FILTER 1: Freshness — reject pickups < 4h away (or in the past).
    const pickupTime = new Date(payload.pickupDate).getTime();
    if (pickupTime < Date.now() + 4 * 3600_000) {
      return fail('Pickup is in the past or less than 4 hours away');
    }

    // FILTER 2: Equipment availability — at least one carrier with this equipment,
    // active authority, valid insurance.
    const normalizedEquip = normalizeEquipment(payload.equipmentType);
    const equipMatch = await db.query<{ count: number }>(
      `SELECT COUNT(DISTINCT ce.carrier_id)::int AS count
       FROM carrier_equipment ce
       JOIN carriers c ON ce.carrier_id = c.id
       WHERE ce.equipment_type = $1
         AND c.authority_status = 'Active'
         AND (c.insurance_expiry IS NULL OR c.insurance_expiry > CURRENT_DATE)`,
      [normalizedEquip],
    );
    if ((equipMatch.rows[0]?.count ?? 0) === 0) {
      return fail(`No active insured carriers with ${normalizedEquip} equipment`);
    }

    // FILTER 3: Lane coverage — carriers with history on this lane (origin region),
    // tolerating dest-region misses (the carrier may still bid).
    const originRegion = extractRegion(formatLocation(payload.origin));
    const destRegion = extractRegion(formatLocation(payload.destination));

    const laneMatch = await db.query<{ count: number }>(
      `SELECT COUNT(DISTINCT cl.carrier_id)::int AS count
       FROM carrier_lanes cl
       JOIN carriers c ON cl.carrier_id = c.id
       WHERE c.authority_status = 'Active'
         AND (c.insurance_expiry IS NULL OR c.insurance_expiry > CURRENT_DATE)
         AND (LOWER(cl.origin_region) = $1 OR LOWER(cl.dest_region) = $2)`,
      [originRegion, destRegion],
    );
    const carrierMatchCount = laneMatch.rows[0]?.count ?? 0;
    // Note: zero lane history isn't fatal — Agent 4 may still find proximity
    // matches via home_lat/lng. We just record the count for priority scoring.

    // FILTER 4: Rate viability via benchmark cascade.
    // benchmark.ratePerMile is the *market revenue* midpoint (what shippers pay).
    // Carrier cost ≈ 78% of that (broker keeps ~22% margin in the typical case).
    const benchmark = getBenchmarkRate(payload.distanceMiles, payload.equipmentType, payload.pickupDate);
    const benchmarkRevenueMid = benchmark.ratePerMile * payload.distanceMiles;
    const expectedCarrierRate = benchmarkRevenueMid * 0.78;
    const postedRate = payload.postedRate ?? benchmarkRevenueMid;
    const estimatedMarginHigh = postedRate - expectedCarrierRate;
    const estimatedMarginLow = estimatedMarginHigh * 0.7;
    const minMargin = payload.origin.country === 'CA' ? 270 : 200;

    if (estimatedMarginHigh < minMargin * 0.5) {
      return fail(`Best-case margin $${estimatedMarginHigh.toFixed(0)} < 50% of minimum $${minMargin}`);
    }

    // FILTER 5: DNC list.
    if (payload.shipperPhone) {
      const dnc = await db.query(`SELECT 1 FROM dnc_list WHERE phone = $1`, [payload.shipperPhone]);
      if (dnc.rows.length > 0) {
        return fail('Shipper phone is on do-not-call list');
      }
    }

    // FILTER 6: Shipper fatigue — too many recent contacts.
    let isRepeatShipper = false;
    if (payload.shipperPhone) {
      const fatigue = await db.query<{
        recent_contacts: number;
        total_calls: number;
        last_outcome: string | null;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM agent_calls
            WHERE phone_number_called = $1
              AND call_initiated_at > NOW() - INTERVAL '14 days') AS recent_contacts,
           (SELECT COUNT(*)::int FROM agent_calls
            WHERE phone_number_called = $1) AS total_calls,
           (SELECT outcome FROM agent_calls
            WHERE phone_number_called = $1
            ORDER BY call_initiated_at DESC NULLS LAST LIMIT 1) AS last_outcome`,
        [payload.shipperPhone],
      );
      const f = fatigue.rows[0];
      if (f) {
        if ((f.recent_contacts ?? 0) >= 3) {
          return fail(`Shipper contacted ${f.recent_contacts} times in last 14 days`);
        }
        if (f.last_outcome === 'declined' && (f.recent_contacts ?? 0) >= 1) {
          return fail('Shipper declined within last 14 days');
        }
        isRepeatShipper = (f.total_calls ?? 0) > 0;
      }
    }

    // ALL PASSED — compute priority.
    const daysUntilPickup = this.daysBetween(new Date(), new Date(payload.pickupDate));
    const priorityScore = this.computePriorityScore({
      estimatedMargin: estimatedMarginHigh,
      carrierMatchCount,
      hasPostedRate: payload.postedRate !== null,
      daysUntilPickup,
      isRepeatShipper,
    });

    return {
      passed: true,
      reason: 'All filters passed',
      priorityScore,
      estimatedMarginLow,
      estimatedMarginHigh,
      carrierMatchCount,
      isRepeatShipper,
    };
  }

  /**
   * Compute priority score (0-1000) for ordering loads downstream.
   * Higher score = higher priority.
   */
  private computePriorityScore(params: {
    estimatedMargin: number;
    carrierMatchCount: number;
    hasPostedRate: boolean;
    daysUntilPickup: number;
    isRepeatShipper: boolean;
  }): number {
    let score = 0;
    score += Math.min(Math.round(params.estimatedMargin * 0.8), 400);
    score += Math.min(params.carrierMatchCount * 40, 200);
    score += params.hasPostedRate ? 150 : 0;
    if (params.daysUntilPickup <= 1) score += 150;
    else if (params.daysUntilPickup <= 3) score += 100;
    else if (params.daysUntilPickup <= 7) score += 50;
    score += params.isRepeatShipper ? 100 : 0;
    return Math.min(score, 1000);
  }

  private daysBetween(a: Date, b: Date): number {
    return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
  }

  /**
   * Override updatePipelineLoad to handle conditional stage advancement.
   * Qualified → 'qualified', Disqualified → 'disqualified'.
   */
  protected async updatePipelineLoad(pipelineLoadId: number, result: any): Promise<void> {
    if (result.details?.passed) {
      await db.query(
        `UPDATE pipeline_loads
         SET stage = 'qualified',
             stage_updated_at = NOW(),
             has_carrier_match = TRUE,
             estimated_margin_low = $2,
             estimated_margin_high = $3,
             priority_score = $4,
             carrier_match_count = $5,
             qualification_reason = 'qualified',
             updated_at = NOW()
         WHERE id = $1`,
        [
          pipelineLoadId,
          result.details.estimatedMargin.low,
          result.details.estimatedMargin.high,
          result.details.priorityScore,
          result.details.carrierMatchCount,
        ],
      );
    } else {
      await db.query(
        `UPDATE pipeline_loads
         SET stage = 'disqualified',
             stage_updated_at = NOW(),
             qualification_reason = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [pipelineLoadId, result.details?.reason ?? 'unspecified'],
      );
    }
    logger.debug(`[Qualifier] Pipeline load ${pipelineLoadId} → ${result.details?.passed ? 'qualified' : 'disqualified'}`);
  }
}
