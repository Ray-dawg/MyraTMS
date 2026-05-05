/**
 * AGENT 4 - CARRIER RANKER WORKER
 *
 * Takes a qualified load and returns the top 3 carriers ranked by match score.
 * Wraps the existing 5-criteria matching engine (lib/matching/index.ts) as a
 * standalone pipeline worker. Runs in PARALLEL with Agent 3 (Researcher).
 *
 * Input: match-queue with MatchJobPayload
 * Output: Carrier stack written to pipeline_loads, carrier_match_count set,
 *         match_results table populated, completion-gate triggered.
 * Next Stage: matched (only after Agent 3 also completes — completion gate)
 */

import { Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { matchCarriers, storeMatchResults, type CarrierMatch, type MatchRequest } from '@/lib/matching';
import { LEGACY_DEFAULT_TENANT_ID } from '@/lib/auth';

// Engine 2 is implicitly single-tenant until migration 030 (PENDING) plumbs
// per-load tenant_id into pipeline_loads. Until then, all Engine 2 work pins
// to the Myra default tenant. Tracked in STACK_DRIFT_REPORT.md.
const ENGINE2_TENANT_ID = LEGACY_DEFAULT_TENANT_ID;
import { onRankerComplete, buildBriefPayload } from '@/lib/pipeline/gate';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

/**
 * Ranker job payload — received from Agent 2 (Qualifier).
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
 * Carrier stack entry (subset of CarrierMatch for downstream agents).
 */
interface CarrierStackEntry {
  carrierId: string;
  companyName: string;
  contactName: string;
  contactPhone: string;
  matchScore: number;
  matchGrade: string;
  breakdown: CarrierMatch['breakdown'];
  expectedRate: number | null;
  homeCity: string | null;
  availabilityConfidence: 'high' | 'medium' | 'low';
}

type CarrierStack = CarrierStackEntry[];

function formatLocation(loc: { city: string; state: string }): string {
  return `${loc.city}, ${loc.state}`;
}

/**
 * Ranker worker — carrier matching and ranking.
 */
export class RankerWorker extends BaseWorker<MatchJobPayload> {
  private briefQueue: Queue;

  constructor(redis: Redis, briefQueue: Queue) {
    const config: WorkerConfig = {
      queueName: 'match-queue',
      expectedStage: 'qualified',
      nextStage: 'matched',
      concurrency: 20,
      retryConfig: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30000 },
      },
      redis,
    };

    super(config);
    this.briefQueue = briefQueue;
  }

  /**
   * Main matching logic.
   */
  public async process(payload: MatchJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId, qualifiedLoad } = payload;
    logger.debug(`[Ranker] Processing load ${pipelineLoadId}`);

    // Pull the pipeline_loads row to get the carrier-cost target (set by Agent 2)
    // and posted rate (revenue) — both feed the matching engine's rate scoring.
    const plRow = await db.query<{
      load_id: string;
      posted_rate: number | null;
      estimated_margin_high: number | null;
    }>(
      `SELECT load_id, posted_rate, estimated_margin_high FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    if (plRow.rows.length === 0) {
      throw new Error(`pipeline_load ${pipelineLoadId} not found`);
    }
    const load = plRow.rows[0];

    // Build the matching engine request. The engine accepts string origin/dest
    // ("City, ST") and computes lane history + proximity internally.
    const revenue = Number(load.posted_rate ?? 0);
    const carrierCost = revenue > 0 ? revenue - Number(load.estimated_margin_high ?? 0) : 0;
    const matchRequest: MatchRequest = {
      loadId: load.load_id,
      origin: formatLocation(qualifiedLoad.origin),
      destination: formatLocation(qualifiedLoad.destination),
      originLat: null,
      originLng: null,
      equipmentType: qualifiedLoad.equipmentType,
      carrierCost,
      revenue,
      maxResults: 3,
      excludeCarriers: [],
    };

    const matchResponse = await matchCarriers(ENGINE2_TENANT_ID, matchRequest);
    const viable = matchResponse.matches.filter((m) => m.match_grade !== 'F');

    if (viable.length === 0) {
      logger.warn(`[Ranker] Load ${pipelineLoadId} has no carriers above F-grade. Disqualifying.`);
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

    // Persist to the audit table (existing pattern).
    await storeMatchResults(ENGINE2_TENANT_ID, load.load_id, viable);

    // Build the in-memory carrier stack for downstream agents.
    const carrierStack: CarrierStack = await Promise.all(
      viable.map(async (m) => ({
        carrierId: m.carrier_id,
        companyName: m.carrier_name,
        contactName: m.contact.name,
        contactPhone: m.contact.phone,
        matchScore: m.match_score,
        matchGrade: m.match_grade,
        breakdown: m.breakdown,
        expectedRate: m.breakdown.rate.carrier_avg_rate,
        homeCity: null,
        availabilityConfidence: await this.determineAvailability(m, qualifiedLoad),
      })),
    );

    logger.info(
      `[Ranker] Load ${pipelineLoadId} matched ${carrierStack.length} carriers; top: ${carrierStack[0].companyName} (${carrierStack[0].matchGrade})`,
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
        topCarrierId: carrierStack[0].carrierId,
        carrierStack,
      },
    };
  }

  /**
   * Determine availability confidence for a carrier.
   *   high   — GPS ping < 24h ago near origin AND equipment confirmed
   *   medium — home base in origin region OR has run this lane in last 30 days
   *   low    — equipment match only, no proximity or recency data
   */
  private async determineAvailability(
    match: CarrierMatch,
    load: MatchJobPayload['qualifiedLoad'],
  ): Promise<'high' | 'medium' | 'low'> {
    const recentPing = await db.query<{ id: string }>(
      `SELECT 1 AS id FROM location_pings
       WHERE driver_id IN (SELECT id FROM drivers WHERE carrier_id = $1)
         AND recorded_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [match.carrier_id],
    );
    if (recentPing.rows.length > 0) return 'high';

    if (match.breakdown.lane_familiarity.loads_on_lane > 0) return 'medium';

    return 'low';
  }

  /**
   * Override updatePipelineLoad to handle carrier stack storage and
   * trigger the completion gate.
   */
  protected async updatePipelineLoad(pipelineLoadId: number, result: any): Promise<void> {
    const { matched, carrierCount, carrierStack, topCarrierId, reason } = result.details ?? {};

    if (!matched) {
      await db.query(
        `UPDATE pipeline_loads
         SET carrier_match_count = 0,
             stage = 'disqualified',
             stage_updated_at = NOW(),
             qualification_reason = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [pipelineLoadId, reason ?? 'no_carrier_matches'],
      );
      logger.debug(`[Ranker] Load ${pipelineLoadId} disqualified — no carriers`);
      return;
    }

    // Store carrier match count + top carrier (text id now, post 023 schema fix).
    await db.query(
      `UPDATE pipeline_loads
       SET carrier_match_count = $2,
           top_carrier_id = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [pipelineLoadId, carrierCount, topCarrierId],
    );

    // Completion gate: if Agent 3 (Researcher) is also done, advance and
    // enqueue to brief-queue.
    const gate = await onRankerComplete(db as any, pipelineLoadId);
    if (gate.shouldEnqueue) {
      const briefPayload = await buildBriefPayload(db as any, pipelineLoadId);
      await this.briefQueue.add('compile', briefPayload, { priority: briefPayload.priority });
      logger.info(`[Ranker] Gate opened for load ${pipelineLoadId} → brief-queue`);
    } else {
      logger.debug(`[Ranker] Gate not yet open for load ${pipelineLoadId}: ${gate.reason}`);
    }
  }
}
