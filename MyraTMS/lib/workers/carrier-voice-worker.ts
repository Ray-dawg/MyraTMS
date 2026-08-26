/**
 * DISPATCH ONE — CARRIER-CALLING CASCADE WORKER (E2-03 M2)
 *
 * Mirrors voice-worker.ts's structure deliberately (PRD §6.3: "proven
 * infrastructure, not a new pattern to debug"). Reads a load's ranked
 * carrier stack from match_results, and — once CARRIER_CALLS_ENABLED is
 * flipped true (a separate, explicit decision from this file existing) —
 * cascades through it: call carrier[i], on decline/no_answer/disconnected
 * advance to i+1, on voicemail retry once, on accept hand off to the
 * webhook's envelope check, on exhaustion (i>N) escalate to a human via the
 * same Alert Center pattern E2-03 M0 established.
 *
 * SHADOW-ONLY IN THIS PLAN'S SCOPE: CARRIER_CALLS_ENABLED defaults false.
 * When false, this worker computes and reports the full cascade decision
 * (which carrier stack, who it would call first) without making any HTTP
 * request to Retell — same shadow-mode contract voice-worker.ts already has
 * via MAX_CONCURRENT_CALLS=0, just a dedicated flag since the carrier side
 * must be independently gate-able from the shipper side (PRD §10/M6:
 * "needed before M2 goes live regardless of M0, since it's what lets the
 * shipper side keep running live while the carrier side sits in shadow").
 *
 * Kill switches enforced before any outbound dial:
 *   - PIPELINE_ENABLED=false        → skip every job
 *   - CARRIER_CALLS_ENABLED!=true   → shadow mode (compute + log, never dial)
 *
 * Concurrency: a per-load Redis lock (lib/pipeline/carrier-locks.ts) ensures
 * only one cascade worker processes a given load's stack at a time; a
 * per-carrier-phone lock (same file) ensures a carrier is never dialed
 * twice concurrently across different loads' cascades.
 *
 * Input:  carrier-call-queue with CarrierCallCascadePayload
 * Output (live mode, once enabled): agent_calls carrier_* row, pipeline_loads
 *         carrier_* columns via retell-webhook.ts's processCarrierCallCompleted.
 * Output (shadow mode, this plan's scope): a computed decision only, no writes
 *         beyond the ProcessResult itself.
 */

import Redis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { acquireLoadLock, releaseLoadLock, acquireCarrierPhoneLock, releaseCarrierPhoneLock } from '@/lib/pipeline/carrier-locks';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

export interface CarrierCallCascadePayload extends BaseJobPayload {}

const DEFAULT_CASCADE_DEPTH = 5; // PRD §12-D4

interface MatchResultRow {
  carrier_id: string;
  match_score: string;
  breakdown: any;
}

export class CarrierVoiceWorker extends BaseWorker<CarrierCallCascadePayload> {
  private retellApiKey: string;
  private retellBaseUrl: string;
  private carrierCallsEnabled: boolean;

  constructor(
    redis: Redis,
    opts: { retellApiKey?: string; retellBaseUrl?: string; carrierCallsEnabled?: boolean } = {},
  ) {
    const config: WorkerConfig = {
      queueName: 'carrier-call-queue',
      expectedStage: 'booked',
      // Same base-worker.ts:122 gotcha voice-worker.ts and (after the E2-03
      // M0 final review) dispatcher-worker.ts both document: handleJob only
      // calls updatePipelineLoad when nextStage is truthy. This worker
      // doesn't override updatePipelineLoad in this plan's shadow-only
      // scope (nothing to persist yet — the webhook does the real writes
      // once a call completes), so nextStage is intentionally left
      // undefined here. Revisit when live-mode dialing is built.
      nextStage: undefined,
      concurrency: 5,
      retryConfig: {
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
      },
      redis,
    };
    super(config);

    this.retellApiKey = opts.retellApiKey ?? process.env.RETELL_API_KEY ?? '';
    this.retellBaseUrl = opts.retellBaseUrl ?? 'https://api.retellai.com';
    this.carrierCallsEnabled = opts.carrierCallsEnabled ?? process.env.CARRIER_CALLS_ENABLED?.trim().toLowerCase() === 'true';
  }

  public async process(payload: CarrierCallCascadePayload): Promise<ProcessResult> {
    const { pipelineLoadId, loadId } = payload;
    logger.debug(`[CarrierVoice] carrier-call-queue job for load ${pipelineLoadId} (${loadId})`);

    if (process.env.PIPELINE_ENABLED !== 'true') {
      logger.info(`[CarrierVoice] PIPELINE_ENABLED=false — skipping load ${pipelineLoadId}`);
      return this.skipResult(pipelineLoadId, 'pipeline_disabled');
    }

    const lockToken = await acquireLoadLock(pipelineLoadId);
    if (!lockToken) {
      logger.warn(`[CarrierVoice] Load ${pipelineLoadId} is already being cascaded — skipping`);
      return this.skipResult(pipelineLoadId, 'load_locked');
    }

    try {
      const stack = await this.fetchCascadeStack(loadId);
      if (stack.length === 0) {
        logger.warn(`[CarrierVoice] No ranked carriers for load ${pipelineLoadId} — nothing to cascade`);
        return this.skipResult(pipelineLoadId, 'no_carriers');
      }

      if (!this.carrierCallsEnabled) {
        logger.info(
          `[CarrierVoice] CARRIER_CALLS_ENABLED=false — shadow mode for load ${pipelineLoadId}. ` +
          `Stack: [${stack.join(', ')}]. Would call: ${stack[0]}`,
        );
        return {
          success: true,
          pipelineLoadId,
          stage: this.config.expectedStage,
          duration: 0,
          details: {
            shadowMode: true,
            cascadeStack: stack,
            wouldCallCarrierId: stack[0],
          },
        };
      }

      // Live-mode dialing (per-carrier-phone lock, actual Retell dial,
      // cascade advance on decline/voicemail-retry/no_answer/disconnected,
      // exhaustion escalation) is out of this plan's scope — this branch is
      // unreachable while CARRIER_CALLS_ENABLED defaults false, and is left
      // as an explicit follow-up rather than a half-built live path nobody
      // asked to ship yet. Throwing here (not silently no-op) so a future
      // session that flips the flag on gets a clear signal to finish this,
      // not a worker that silently does nothing once "enabled."
      throw new Error(
        '[CarrierVoice] CARRIER_CALLS_ENABLED=true but live dialing is not implemented in this build — ' +
        'do not flip this flag until a follow-up session implements the actual dial/cascade-advance logic.',
      );
    } finally {
      await releaseLoadLock(pipelineLoadId, lockToken);
    }
  }

  private skipResult(pipelineLoadId: number, reason: string): ProcessResult {
    return {
      success: true,
      pipelineLoadId,
      stage: this.config.expectedStage,
      duration: 0,
      details: { skipped: true, reason },
    };
  }

  /**
   * Top-N carriers for a load, ranked by match_score DESC. Matches the
   * exact query pattern dispatcher-worker.ts's fetchCarrierRate() already
   * uses against this table (load_id here is pipeline_loads.load_id, the
   * board-source string ID, not the TMS loads.id — a pre-existing schema-
   * vs-reality quirk documented elsewhere in this codebase, not something
   * this task introduces or should "fix").
   */
  private async fetchCascadeStack(loadId: string, depth: number = DEFAULT_CASCADE_DEPTH): Promise<string[]> {
    const r = await db.query<MatchResultRow>(
      `SELECT carrier_id, match_score, breakdown FROM match_results
       WHERE load_id = $1
       ORDER BY match_score DESC
       LIMIT $2`,
      [loadId, depth],
    );
    return r.rows.map((row) => row.carrier_id);
  }
}
