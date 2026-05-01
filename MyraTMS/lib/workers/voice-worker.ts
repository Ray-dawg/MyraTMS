/**
 * AGENT 6 - VOICE AGENT WORKER (RETELL AI)
 *
 * Initiates phone calls via Retell. Receives a precompiled NegotiationBrief
 * + RetellCreatePhoneCallPayload from Agent 5 (Compiler) and POSTs it to
 * Retell's /v2/create-phone-call API. The voice agent itself runs on Retell
 * — this worker just dials.
 *
 * Call results return asynchronously via webhook
 * (POST /api/webhooks/retell-callback) and are processed by the prebuilt
 * handleRetellWebhook in lib/pipeline/retell-webhook.ts.
 *
 * Kill switches enforced before any outbound dial:
 *   - PIPELINE_ENABLED=false           → skip every job
 *   - MAX_CONCURRENT_CALLS=0           → shadow mode (build the payload but
 *                                        never call Retell)
 *
 * Pre-call rechecks (point-in-time, not the brief's frozen moment):
 *   - DNC list query
 *   - Calling-hours window (8am–8pm shipper local)
 *   - Active concurrent call count
 *
 * Input:  call-queue with CallJobPayload
 * Output: Retell call initiated, agent_calls row created with the Retell
 *         call_id, pipeline_loads.stage advanced to 'calling'.
 *         BaseWorker auto-stage-advance is bypassed — this worker writes
 *         the stage update + agent_calls row in one updatePipelineLoad call.
 */

import Redis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import type {
  RetellCreatePhoneCallPayload,
  NegotiationBrief,
} from '@/lib/pipeline/negotiation-brief';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

export interface CallJobPayload extends BaseJobPayload {
  briefId: number;
  retellPayload: RetellCreatePhoneCallPayload;
}

interface RetellCreatePhoneCallResponse {
  call_id: string;
  call_status?: string;
  agent_id?: string;
  from_number?: string;
  to_number?: string;
  metadata?: Record<string, unknown>;
}

export class VoiceWorker extends BaseWorker<CallJobPayload> {
  private retellApiKey: string;
  private retellBaseUrl: string;

  constructor(redis: Redis, opts: { retellApiKey?: string; retellBaseUrl?: string } = {}) {
    const config: WorkerConfig = {
      queueName: 'call-queue',
      expectedStage: 'briefed',
      // nextStage left undefined — updatePipelineLoad does its own stage write
      // because we also need to insert into agent_calls atomically with the
      // stage transition.
      nextStage: undefined,
      concurrency: 100,
      retryConfig: {
        // Voice calls don't get auto-retried — non-conversation outcomes
        // (no_answer/voicemail/busy) come back as webhook events and are
        // routed to call-queue with a delay by the webhook handler.
        attempts: 1,
        backoff: { type: 'fixed', delay: 0 },
      },
      redis,
    };
    super(config);

    this.retellApiKey = opts.retellApiKey ?? process.env.RETELL_API_KEY ?? '';
    this.retellBaseUrl = opts.retellBaseUrl ?? 'https://api.retellai.com';

    if (!this.retellApiKey) {
      logger.warn('[Voice] RETELL_API_KEY not set — calls will fail with 401');
    }
  }

  public async process(payload: CallJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId, briefId, retellPayload } = payload;
    const phone = retellPayload.to_number;
    const masked = logger.maskPhone(phone);

    logger.debug(`[Voice] call-queue job for load ${pipelineLoadId}, brief ${briefId}, to ${masked}`);

    if (process.env.PIPELINE_ENABLED !== 'true') {
      logger.info(`[Voice] PIPELINE_ENABLED=false — skipping load ${pipelineLoadId}`);
      return this.skipResult(pipelineLoadId, 'pipeline_disabled');
    }

    const maxConcurrent = Number(process.env.MAX_CONCURRENT_CALLS ?? '1');
    if (maxConcurrent <= 0) {
      logger.info(
        `[Voice] MAX_CONCURRENT_CALLS=${maxConcurrent} — shadow mode, not dialing load ${pipelineLoadId}`,
      );
      return this.skipResult(pipelineLoadId, 'shadow_mode');
    }

    const compliance = await this.recheckCompliance(phone, retellPayload);
    if (!compliance.allowed) {
      logger.warn(
        `[Voice] Compliance recheck blocked load ${pipelineLoadId}: ${compliance.reason}`,
      );
      return this.skipResult(pipelineLoadId, `compliance_block:${compliance.reason}`);
    }

    const activeCalls = await this.countActiveCalls();
    if (activeCalls >= maxConcurrent) {
      logger.warn(
        `[Voice] Concurrency cap reached (${activeCalls}/${maxConcurrent}); deferring load ${pipelineLoadId}`,
      );
      return this.skipResult(pipelineLoadId, 'concurrency_cap');
    }

    const callId = await this.dialRetell(retellPayload);

    logger.info(
      `[Voice] Call initiated for load ${pipelineLoadId}. retell_call_id=${callId}, persona=${retellPayload.metadata.persona}, to=${masked}`,
    );

    return {
      success: true,
      pipelineLoadId,
      stage: this.config.expectedStage,
      duration: 0,
      details: {
        callId,
        retellAgentId: retellPayload.agent_id,
        phone: masked,
        persona: retellPayload.metadata.persona,
        briefId,
      },
    };
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
   * Real-time compliance recheck. The brief's compliance block is a point-in-
   * time snapshot from when Agent 5 ran; by the time we dial that may be hours
   * stale. We recheck the gates that can flip (DNC adds, time-of-day) but trust
   * the brief for jurisdictional notes and consent type.
   */
  private async recheckCompliance(
    phone: string,
    retellPayload: RetellCreatePhoneCallPayload,
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (!phone) return { allowed: false, reason: 'no_phone' };

    const dnc = await db.query<{ id: number }>(
      `SELECT id FROM dnc_list WHERE phone = $1 LIMIT 1`,
      [phone],
    );
    if (dnc.rows.length > 0) return { allowed: false, reason: 'dnc_added' };

    // Calling hours: 08:00–20:00 in shipper's local timezone.
    const tz = (retellPayload.metadata as any).timezone || 'America/Toronto';
    const hour = this.localHour(new Date(), tz);
    if (hour < 8 || hour >= 20) {
      return { allowed: false, reason: `outside_calling_hours_local_${hour}h` };
    }

    return { allowed: true };
  }

  private localHour(now: Date, timeZone: string): number {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hour12: false,
        timeZone,
      });
      const parts = fmt.formatToParts(now);
      const h = parts.find((p) => p.type === 'hour')?.value;
      const n = h ? parseInt(h, 10) : now.getUTCHours();
      // Intl returns "24" for midnight in some locales; normalize.
      return n === 24 ? 0 : n;
    } catch {
      return now.getHours();
    }
  }

  /**
   * How many calls are currently in 'calling' stage. We count pipeline_loads
   * rather than agent_calls because the same load can have several agent_calls
   * rows (retries) but only one at a time should be holding 'calling'.
   */
  private async countActiveCalls(): Promise<number> {
    const r = await db.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM pipeline_loads WHERE stage = 'calling'`,
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  /**
   * POST to Retell. Throws on non-2xx so BullMQ logs the failure; calls don't
   * auto-retry (per attempts:1 config) but the orchestrator above can decide
   * whether to re-enqueue.
   */
  private async dialRetell(payload: RetellCreatePhoneCallPayload): Promise<string> {
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

    const data = (await res.json()) as RetellCreatePhoneCallResponse;
    if (!data.call_id) {
      throw new Error(`Retell response missing call_id: ${JSON.stringify(data)}`);
    }
    return data.call_id;
  }

  /**
   * Override: write agent_calls row + advance pipeline_loads stage.
   * Skip cases (kill-switch, compliance block, concurrency) leave stage at
   * 'briefed' and don't insert an agent_calls row.
   */
  protected async updatePipelineLoad(pipelineLoadId: number, result: ProcessResult): Promise<void> {
    if (result.details?.skipped) {
      logger.debug(
        `[Voice] Load ${pipelineLoadId} not advanced (skipped: ${result.details.reason})`,
      );
      return;
    }

    const callId = result.details?.callId as string | undefined;
    const retellAgentId = result.details?.retellAgentId as string | undefined;
    const briefId = result.details?.briefId as number | undefined;
    if (!callId || !briefId) {
      throw new Error(
        `[Voice] Cannot persist call without callId+briefId. Got callId=${callId} briefId=${briefId}`,
      );
    }

    const briefRow = await db.query<{ brief: NegotiationBrief }>(
      `SELECT brief FROM negotiation_briefs WHERE id = $1`,
      [briefId],
    );
    const brief = briefRow.rows[0]?.brief;

    await db.query(
      `INSERT INTO agent_calls (
         pipeline_load_id, call_id, call_type, persona, language, currency,
         retell_call_id, retell_agent_id, phone_number_called,
         call_initiated_at, negotiation_brief_id,
         initial_offer, min_acceptable_rate, target_rate,
         outcome, created_at
       ) VALUES (
         $1, $2, 'outbound_shipper', $3, $4, $5,
         $6, $7, $8,
         NOW(), $9,
         $10, $11, $12,
         'in_progress', NOW()
       )`,
      [
        pipelineLoadId,
        callId,
        brief?.persona?.personaName ?? null,
        brief?.callConfig?.language ?? 'en',
        brief?.rates?.currency ?? 'CAD',
        callId,
        retellAgentId ?? brief?.persona?.retellAgentId ?? null,
        brief?.shipper?.phone ?? null,
        briefId,
        brief?.negotiation?.initialOffer ?? null,
        brief?.negotiation?.walkAwayRate ?? null,
        brief?.rates ? brief.rates.totalCost + brief.rates.targetMargin : null,
      ],
    );

    await db.query(
      `UPDATE pipeline_loads
       SET stage = 'calling',
           stage_updated_at = NOW(),
           call_attempts = COALESCE(call_attempts, 0) + 1,
           last_call_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [pipelineLoadId],
    );

    logger.debug(`[Voice] Load ${pipelineLoadId} → 'calling'; agent_calls row created`);
  }
}
