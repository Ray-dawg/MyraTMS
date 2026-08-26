/**
 * DISPATCH ONE — CARRIER-CALLING CASCADE WORKER (E2-03 M2)
 *
 * Mirrors voice-worker.ts's structure deliberately (PRD §6.3: "proven
 * infrastructure, not a new pattern to debug"). Reads a load's ranked
 * carrier stack from match_results, and cascades through it: call
 * carrier[i], on decline/no_answer/disconnected advance to i+1, on
 * voicemail retry once, on accept hand off to the webhook's envelope
 * check, on exhaustion (i>N) escalate to a human via the same Alert Center
 * pattern E2-03 M0 established. The state machine deciding what happens
 * after each outcome lives in lib/pipeline/carrier-cascade.ts
 * (decideCascadeAction) and runs from retell-webhook.ts once a call's
 * outcome comes back — this file's job is only the dial itself: fetch the
 * stack, resolve the carrier at the requested cascade position, and place
 * the call (or, in shadow mode, just report what it would do).
 *
 * SHADOW-GATED: CARRIER_CALLS_ENABLED defaults false. When false, this
 * worker computes and reports the full cascade decision (which carrier
 * stack, who it would call first) without making any HTTP request to
 * Retell — same shadow-mode contract voice-worker.ts already has via
 * MAX_CONCURRENT_CALLS=0, just a dedicated flag since the carrier side
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
 * per-carrier-phone lock (same file) is held around the dial so a carrier
 * is never dialed twice concurrently across different loads' cascades — if
 * the lock is already held, this worker skips cleanly (details.reason =
 * 'carrier_phone_locked') rather than dialing anyway.
 *
 * Input:  carrier-call-queue with CarrierCallCascadePayload (cascadePosition
 *         and voicemailRetryCount both default to 0 — the first dial in a
 *         fresh cascade; retell-webhook.ts's enqueueCascadeStep() sets them
 *         explicitly on every re-enqueue).
 * Output (live mode): a real Retell dial + an agent_calls carrier_* row
 *         with outcome='in_progress'. The actual outcome (accept/decline/
 *         voicemail/etc.) and any resulting cascade advance/retry/escalate
 *         are written later by retell-webhook.ts once Retell calls back —
 *         this worker never writes an outcome itself.
 * Output (shadow mode): a computed decision only, no writes beyond the
 *         ProcessResult itself.
 */

import Redis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { acquireLoadLock, releaseLoadLock, acquireCarrierPhoneLock, releaseCarrierPhoneLock } from '@/lib/pipeline/carrier-locks';
import { escalateCascadeExhausted } from '@/lib/pipeline/carrier-cascade';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

export interface CarrierCallCascadePayload extends BaseJobPayload {
  cascadePosition?: number;
  voicemailRetryCount?: number;
}

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
      // Same base-worker.ts:122 gotcha voice-worker.ts documents: handleJob
      // only calls updatePipelineLoad when nextStage is truthy. This worker
      // deliberately leaves nextStage undefined — a carrier dial attempt
      // never changes pipeline_loads.stage (it stays 'booked' throughout
      // the cascade); only cascade exhaustion or a webhook-confirmed
      // outcome does that, and both write directly rather than going
      // through this base-class hook. The agent_calls row for a live dial
      // is inserted directly in process() below for the same reason.
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

      const position = payload.cascadePosition ?? 0;
      const voicemailRetryCount = payload.voicemailRetryCount ?? 0;

      // Defensive out-of-bounds check: retell-webhook.ts's
      // decideCascadeAction() never re-enqueues past the last position (it
      // returns 'exhausted' instead), so this should be unreachable in
      // normal operation. It's here so a bad re-enqueue fails visibly
      // (escalates) rather than dialing undefined or crashing on
      // stack[position].
      if (position >= stack.length) {
        const loadRow = await db.query<{
          origin_city: string; origin_state: string; destination_city: string; destination_state: string;
        }>(
          `SELECT origin_city, origin_state, destination_city, destination_state FROM pipeline_loads WHERE id = $1`,
          [pipelineLoadId],
        );
        const l = loadRow.rows[0];
        await escalateCascadeExhausted({
          pipelineLoadId, loadId, stack,
          originCity: l?.origin_city ?? '', originState: l?.origin_state ?? '',
          destinationCity: l?.destination_city ?? '', destinationState: l?.destination_state ?? '',
        });
        return {
          success: true,
          pipelineLoadId,
          stage: this.config.expectedStage,
          duration: 0,
          details: { cascadeExhausted: true, position, stackLength: stack.length },
        };
      }

      const carrierId = stack[position];
      const carrierRow = await db.query<{ contact_phone: string | null }>(
        `SELECT contact_phone FROM carriers WHERE id = $1`,
        [carrierId],
      );
      const carrierPhone = carrierRow.rows[0]?.contact_phone ?? null;
      if (!carrierPhone) {
        logger.warn(`[CarrierVoice] Carrier ${carrierId} has no contact_phone — cannot dial`);
        return this.skipResult(pipelineLoadId, 'carrier_no_phone');
      }

      const phoneLockToken = await acquireCarrierPhoneLock(carrierPhone);
      if (!phoneLockToken) {
        logger.warn(
          `[CarrierVoice] Carrier ${carrierId} (${logger.maskPhone(carrierPhone)}) is already being dialed on another load's cascade — skipping`,
        );
        return this.skipResult(pipelineLoadId, 'carrier_phone_locked');
      }

      try {
        const callId = await this.dialRetell({
          to_number: carrierPhone,
          metadata: {
            pipelineLoadId,
            callType: 'outbound_carrier',
            cascadePosition: position,
            voicemailRetryCount,
            carrierId,
            stackLength: stack.length,
          },
        });

        await db.query(
          `INSERT INTO agent_calls (
             pipeline_load_id, call_id, call_type, retell_call_id, phone_number_called,
             call_initiated_at, carrier_outcome, created_at
           ) VALUES ($1, $2, 'outbound_carrier', $3, $4, NOW(), 'in_progress', NOW())`,
          [pipelineLoadId, callId, callId, carrierPhone],
        );

        logger.info(
          `[CarrierVoice] Carrier call initiated for load ${pipelineLoadId}, carrier ${carrierId} ` +
          `(position ${position}/${stack.length}). retell_call_id=${callId}`,
        );

        return {
          success: true,
          pipelineLoadId,
          stage: this.config.expectedStage,
          duration: 0,
          details: { callId, carrierId, position, stackLength: stack.length },
        };
      } finally {
        // TTL-based expiry (5 min, carrier-locks.ts default) is the real
        // release mechanism for the duration of the actual call — the
        // webhook resolving the outcome runs in a separate request/process
        // later and doesn't hold this function's lock token, so it can't
        // call releaseCarrierPhoneLock() explicitly. Releasing here too
        // (immediately after the dial *attempt* returns, not after the
        // call itself ends) only protects the synchronous dial-request
        // window; the TTL is what actually prevents a double-dial for the
        // minutes the real conversation is in progress.
        await releaseCarrierPhoneLock(carrierPhone, phoneLockToken);
      }
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

  /**
   * POST to Retell. Mirrors voice-worker.ts's dialRetell, trimmed to the
   * fields the carrier cascade needs — the carrier side doesn't build a
   * full NegotiationBrief-derived RetellCreatePhoneCallPayload (M2 doesn't
   * add a carrier-side brief compiler), just enough metadata for the
   * webhook to route the outcome back to the right cascade state.
   */
  private async dialRetell(payload: {
    to_number: string;
    metadata: Record<string, unknown>;
  }): Promise<string> {
    const res = await fetch(`${this.retellBaseUrl}/v2/create-phone-call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.retellApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '<unparseable>');
      throw new Error(`Retell create-phone-call ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { call_id?: string };
    if (!data.call_id) {
      throw new Error(`Retell response missing call_id: ${JSON.stringify(data)}`);
    }
    return data.call_id;
  }
}
