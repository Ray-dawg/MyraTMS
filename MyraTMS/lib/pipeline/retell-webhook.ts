/**
 * RETELL WEBHOOK HANDLER
 *
 * Inbound webhook handler for /api/webhooks/retell-callback
 * Processes call completion events from Retell AI.
 *
 * This is the bridge between the voice agent and the data pipeline.
 * Flow: Retell → Webhook → Parser → Database → Queue enqueue
 *
 * Security: HMAC-SHA256 signature verification, timing-safe comparison
 * Error handling: Retry logic, dead letter fallback, audit logging
 *
 * @module retell-webhook
 * @version 1.0.0
 */

import crypto from 'crypto';
import { db } from '@/lib/pipeline/db-adapter';
import { redisConnection as redis } from '@/lib/pipeline/redis-bullmq';
import { Queue } from 'bullmq';
import {
  RetellWebhookPayload,
  WebhookResponse,
  CallResult,
  CallMetadata,
  ProcessResult,
  SignatureVerificationResult,
  AgentCallRecord,
  PipelineLoadUpdate,
  DispatchQueuePayload,
  CallbackQueuePayload,
  EscalationQueuePayload,
  RetryQueuePayload,
  ShipperPreferencesUpdate,
  AuditLogEntry,
} from './retell-types';

// ============================================================================
// QUEUE INITIALIZATION
// ============================================================================

/**
 * Initialize BullMQ queue connections for downstream processing
 */
const dispatchQueue = new Queue('dispatch-queue', { connection: redis });
const callbackQueue = new Queue('callback-queue', { connection: redis });
const escalationQueue = new Queue('escalation-queue', { connection: redis });
const retryQueue = new Queue('call-queue', { connection: redis });
const carrierCallQueue = new Queue('carrier-call-queue', { connection: redis });
// E2-04 M2: booking no longer enqueues dispatch-queue directly -- it goes
// through shipper written-confirmation first. See enqueueNextAction()'s
// 'booked' case below.
const shipperConfirmationQueue = new Queue('shipper-confirmation-queue', { connection: redis });

// ============================================================================
// MAIN WEBHOOK HANDLER
// ============================================================================

/**
 * Main entry point for Retell webhook callbacks.
 * Called by POST /api/webhooks/retell-callback
 *
 * Flow:
 * 1. Parse request body
 * 2. Verify HMAC signature
 * 3. Extract metadata
 * 4. Route to appropriate handler based on call_status
 * 5. Write results to database
 * 6. Enqueue next action
 * 7. Return 200 OK
 *
 * @param req - Express/Next.js request with JSON body
 * @returns WebhookResponse with 200 on success, 4xx/5xx on error
 */
export async function handleRetellWebhook(
  req: any // Next.js Request object
): Promise<WebhookResponse> {
  const startTime = Date.now();

  // Step 0: Read the RAW body and verify the signature BEFORE parsing or trusting
  // any field. Uses the official Retell SDK verifier, which implements Retell's
  // real scheme: header `v={ms},d={digest}`, HMAC-SHA256 over (rawBody+timestamp)
  // keyed by the webhook-badged API key, with a 5-minute freshness window. The
  // previous hand-rolled HMAC (re-stringified body, no timestamp, wrong key,
  // hex-decoding the whole `v=,d=` header) rejected every real Retell webhook.
  const rawBody =
    typeof req.text === 'function' ? await req.text() : JSON.stringify(await req.json());
  const signature =
    req.headers['x-retell-signature'] || req.headers['X-Retell-Signature'] || '';

  if (!verifyRetellSignature(rawBody, signature)) {
    console.error('[SECURITY] Invalid Retell webhook signature');
    return { status: 401, body: { error: 'Invalid signature', processed: false } };
  }

  // Parse only AFTER the signature is trusted, and guard the shape so a
  // malformed-but-signed body returns 400 instead of crashing to 500.
  let payload: RetellWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as RetellWebhookPayload;
  } catch {
    return { status: 400, body: { error: 'Invalid JSON', processed: false } };
  }
  if (!payload || !payload.metadata) {
    return { status: 400, body: { error: 'Missing metadata', processed: false } };
  }

  try {
    // Step 1: Log incoming webhook
    await auditLog({
      timestamp: new Date(),
      eventType: 'webhook_received',
      pipelineLoadId: payload.metadata.pipelineLoadId,
      callId: payload.call_id,
      phone: payload.to_number,
      details: { call_status: payload.call_status },
      severity: 'info',
    });

    // Step 3: Extract metadata
    const metadata = extractCallMetadata(payload);

    // Step 4: Route by call status
    let result: ProcessResult;

    if (metadata.callType === 'outbound_carrier') {
      // Carrier calls are dispatched to the carrier-specific handler for ANY
      // status, not just 'completed'. This must be checked before the status
      // ladder below — otherwise a carrier call with status 'failed',
      // 'no_answer', 'voicemail', or 'busy' would fall through to the
      // shipper-only processCallFailed()/processNonConversation(), which
      // write to the shared agreed_rate/profit/stage columns those
      // functions own (whole-branch review finding 1). Unreachable today
      // (shadow mode never dials a carrier), but fails closed instead of
      // silently mis-routing once carrier calling goes live.
      // Every call_status a carrier call can come back with is cascade-aware
      // now (E2-03 M2 Session 2) — 'completed' still goes through the
      // envelope+transcript path, everything else (no_answer/voicemail/busy/
      // failed) goes through processCarrierCallOutcome(), which maps them to
      // decideCascadeAction() and either re-enqueues carrier-call-queue or
      // escalates on exhaustion. Nothing carrier-side falls through to the
      // shipper-only handlers below this branch.
      result =
        payload.call_status === 'completed'
          ? await processCarrierCallCompleted(payload, metadata)
          : await processCarrierCallOutcome(payload, metadata);
    } else if (payload.call_status === 'completed') {
      result = await processCallCompleted(payload, metadata);
    } else if (payload.call_status === 'failed') {
      result = await processCallFailed(payload, metadata);
    } else if (['no_answer', 'voicemail', 'busy'].includes(payload.call_status)) {
      result = await processNonConversation(payload, metadata);
    } else {
      result = {
        success: false,
        pipelineLoadId: metadata.pipelineLoadId,
        callId: payload.call_id,
        outcome: 'unknown_status',
        nextAction: 'escalate_human',
        error: `Unknown call status: ${payload.call_status}`,
        timestamp: new Date(),
      };
    }

    // Step 5: Log processing result
    const duration = Date.now() - startTime;
    console.log('[WEBHOOK] Processed call', {
      callId: payload.call_id,
      outcome: result.outcome,
      nextAction: result.nextAction,
      duration: `${duration}ms`,
      success: result.success,
    });

    await auditLog({
      timestamp: new Date(),
      eventType: 'webhook_processed',
      pipelineLoadId: metadata.pipelineLoadId,
      callId: payload.call_id,
      phone: payload.to_number,
      details: {
        outcome: result.outcome,
        nextAction: result.nextAction,
        durationMs: duration,
      },
      severity: result.success ? 'info' : 'warning',
    });

    return {
      status: result.success ? 200 : 400,
      body: {
        processed: result.success,
        outcome: result.outcome,
        details: result.details,
      },
    };
  } catch (error) {
    console.error('[WEBHOOK] Unhandled error:', error);

    const errorContext: any = {
      error: error instanceof Error ? error.message : String(error),
      callId: payload.call_id,
      pipelineLoadId: payload.metadata.pipelineLoadId,
    };

    await auditLog({
      timestamp: new Date(),
      eventType: 'webhook_error',
      pipelineLoadId: payload.metadata.pipelineLoadId,
      callId: payload.call_id,
      phone: payload.to_number,
      details: errorContext,
      severity: 'error',
    });

    return {
      status: 500,
      body: {
        error: 'Internal server error',
        processed: false,
        details: error instanceof Error ? error.message : undefined,
      },
    };
  }
}

// ============================================================================
// SIGNATURE VERIFICATION (Security Critical)
// ============================================================================

/**
 * Validate Retell webhook signature using HMAC-SHA256.
 *
 * Security:
 * - Uses timing-safe comparison (crypto.timingSafeEqual)
 * - Prevents timing attacks that could leak valid signatures
 * - Uses SHA-256 for industry-standard security
 *
 * @param payload - Raw JSON string from Retell
 * @param signature - Signature header from Retell
 * @param secret - Webhook secret from environment
 * @returns SignatureVerificationResult with validity and error (if any)
 */
/**
 * Verify a Retell webhook signature per Retell's documented scheme:
 *   header : `v={unix_ms_timestamp},d={hex_digest}`
 *   digest : HMAC-SHA256(rawBody + timestamp) keyed by the webhook-badged API key
 *   window : timestamp must be within 5 minutes of now
 *
 * retell-sdk v5 removed its `verify()` helper, so this implements the scheme
 * directly over the RAW body. It is robust to two bring-up ambiguities WITHOUT
 * weakening security: it tries both configured keys (RETELL_WEBHOOK_SECRET /
 * RETELL_API_KEY — only one carries Retell's "webhook" badge) and the documented
 * message orderings. Every candidate still requires possession of one of our own
 * account keys, so the extra candidates don't help a forger. Once we confirm the
 * exact (key, ordering) from a real call's logs, this can be narrowed to one.
 */
export function verifyRetellSignature(rawBody: string, header: string): boolean {
  if (!header) return false;
  const m = /v=(\d+),\s*d=([0-9a-fA-F]+)/.exec(header);
  if (!m) return false;
  const timestamp = m[1];
  const digest = m[2].toLowerCase();

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) return false;

  const keys = [process.env.RETELL_WEBHOOK_SECRET, process.env.RETELL_API_KEY].filter(
    (k): k is string => !!k,
  );
  const messages = [rawBody + timestamp, timestamp + rawBody, `${timestamp}.${rawBody}`];

  for (const key of keys) {
    for (const msg of messages) {
      const expected = crypto.createHmac('sha256', key).update(msg).digest('hex');
      if (
        expected.length === digest.length &&
        crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digest))
      ) {
        return true;
      }
    }
  }
  return false;
}

export function validateRetellSignature(
  payload: string,
  signature: string,
  secret: string
): SignatureVerificationResult {
  if (!signature) {
    return {
      valid: false,
      error: 'Missing signature header',
    };
  }

  if (!secret) {
    return {
      valid: false,
      error: 'Webhook secret not configured',
    };
  }

  try {
    // Compute expected signature
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    const expectedSignature = hmac.digest('hex');

    // Timing-safe comparison
    try {
      const signatureBuffer = Buffer.from(signature, 'hex');
      const expectedBuffer = Buffer.from(expectedSignature, 'hex');

      const isValid = crypto.timingSafeEqual(
        signatureBuffer,
        expectedBuffer
      );

      return { valid: isValid };
    } catch (e) {
      // timingSafeEqual throws if buffers are different lengths
      return {
        valid: false,
        error: 'Signature format mismatch',
      };
    }
  } catch (error) {
    return {
      valid: false,
      error: `Signature verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================================================
// CALL OUTCOME PROCESSORS
// ============================================================================

/**
 * Process a completed call (transcript available).
 *
 * Flow:
 * 1. Call Claude API to parse transcript
 * 2. Validate parsing result
 * 3. Recompute profit (never trust Claude's math)
 * 4. Write to agent_calls table
 * 5. Update pipeline_loads stage
 * 6. Enqueue next action
 * 7. Update shipper preferences
 *
 * @param payload - Retell webhook payload
 * @param metadata - Extracted call metadata
 * @returns ProcessResult with outcome and next action
 */
export async function processCallCompleted(
  payload: RetellWebhookPayload,
  metadata: CallMetadata
): Promise<ProcessResult> {
  const { pipelineLoadId, briefId, currency } = metadata;

  try {
    // Fetch the brief for context
    const briefResult = await db.query(
      'SELECT brief FROM negotiation_briefs WHERE id = $1',
      [briefId]
    );

    if (briefResult.rows.length === 0) {
      throw new Error(`Brief not found: ${briefId}`);
    }

    const brief = briefResult.rows[0].brief;

    // Parse transcript via Claude API (BUILD 3)
    const callResult = await parseCall(
      payload.transcript,
      brief,
      metadata,
      payload
    );

    // Recompute profit (critical: never trust Claude)
    if (callResult.final_rate !== null) {
      const totalCost = brief.rates?.totalCost || 0;
      callResult.profit = callResult.final_rate - totalCost;

      callResult.profit_tier =
        callResult.profit >= 500
          ? 'excellent'
          : callResult.profit >= 350
          ? 'good'
          : callResult.profit >= 200
          ? 'acceptable'
          : 'below_minimum';

      const minMargin = brief.rates?.minMargin || 200;
      callResult.auto_book_eligible = callResult.profit >= minMargin;
    }

    // Write to agent_calls table
    await writeAgentCall(payload, callResult, metadata, brief);

    // Determine next action based on outcome
    const pipelineUpdate = determinePipelineStage(callResult);

    // Update pipeline_loads
    await updatePipelineLoad(pipelineLoadId, pipelineUpdate);

    // Enqueue next action
    await enqueueNextAction(
      callResult.outcome,
      pipelineLoadId,
      payload.call_id,
      metadata,
      callResult
    );

    // Update shipper preferences
    await updateShipperPreferences(payload.to_number, callResult, metadata);

    return {
      success: true,
      pipelineLoadId,
      callId: payload.call_id,
      outcome: callResult.outcome,
      nextAction: callResult.next_action,
      details: {
        finalRate: callResult.final_rate,
        profit: callResult.profit,
        profitTier: callResult.profit_tier,
        sentiment: callResult.sentiment,
        confidence: callResult.confidence,
      },
      timestamp: new Date(),
    };
  } catch (error) {
    console.error('[WEBHOOK] Error processing completed call:', {
      callId: payload.call_id,
      error: error instanceof Error ? error.message : String(error),
    });

    // On parse error: escalate to human
    await updatePipelineLoad(pipelineLoadId, {
      id: pipelineLoadId,
      stage: 'escalated',
      stage_updated_at: new Date(),
      call_attempts: await getCallAttempts(pipelineLoadId),
      last_call_at: new Date(),
      call_outcome: 'parsing_failed',
      agreed_rate: null,
      agreed_rate_currency: null,
      profit: null,
      profit_margin_pct: null,
      auto_booked: false,
      booked_at: null,
      tms_load_id: null,
    });

    await escalationQueue.add(
      'escalate',
      {
        pipelineLoadId,
        reason: 'Call transcript parsing failed',
        callId: payload.call_id,
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
        timestamp: new Date().toISOString(),
      } as EscalationQueuePayload
    );

    return {
      success: false,
      pipelineLoadId,
      callId: payload.call_id,
      outcome: 'parsing_failed',
      nextAction: 'escalate_human',
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date(),
    };
  }
}

// ============================================================================
// CARRIER CALL COMPLETION (E2-03 M2 §6.7)
// ============================================================================
//
// Parallel to processCallCompleted() above, but for carrier calls. Writes to
// agent_calls' carrier_* columns (Task 1's migration 042) and pipeline_loads'
// carrier_* columns (E2-03 M0's migration 041) — never the shared agreed_rate/
// profit/stage/outcome columns those functions own. Deliberately does not
// call parseCall(), writeAgentCall(), updatePipelineLoad(), or
// enqueueNextAction() — those are shipper-specific and stay untouched.
//
// Outcome/rate extraction here is a minimal heuristic, not Claude-based
// transcript parsing — real carrier transcript understanding is out of scope
// until M2 places real calls (a later session). This function's job for now
// is proving the write-path is correct given a determined outcome, per PRD
// §6.7's literal requirement.

interface CarrierCallOutcome {
  outcome: 'accept' | 'decline' | 'voicemail' | 'no_answer' | 'disconnected' | 'escalated';
  agreedRate: number | null;
}

function parseCarrierTranscript(transcript: string | undefined | null): CarrierCallOutcome {
  if (!transcript) return { outcome: 'decline', agreedRate: null };
  // Bounded gap (up to 4 words) between "agreed to" and the dollar amount so
  // short phrasing variants ("run the load at", "run it at") still match,
  // but an unrelated number many words later — e.g. "agreed to think it
  // over and get back to us at 1800 CAD tomorrow" — can't be reached by
  // skipping across arbitrary intervening text (which an unbounded .*? did).
  const acceptMatch = transcript.match(/agreed?\s+to(?:\s+\w+){0,4}\s+\$?(\d[\d,]*(?:\.\d+)?)/i);
  if (acceptMatch) {
    return { outcome: 'accept', agreedRate: Number(acceptMatch[1].replace(/,/g, '')) };
  }
  return { outcome: 'decline', agreedRate: null };
}

export async function processCarrierCallCompleted(
  payload: RetellWebhookPayload,
  metadata: CallMetadata,
): Promise<ProcessResult> {
  const { pipelineLoadId } = metadata;

  try {
    const parsed = parseCarrierTranscript((payload as any).transcript);

    // Envelope enforcement (PRD §6.3/§6.5): an accepted rate above the
    // ceiling is never booked, it's escalated — the same fail-closed
    // posture as every other gate in this arc. Ceiling is computed from the
    // shipper's already-agreed rate (pipeline_loads.agreed_rate), never from
    // the carrier's own ask.
    let finalOutcome: CarrierCallOutcome['outcome'] = parsed.outcome;
    let carrierProfit: number | null = null;
    // Currency used for the envelope/ceiling computation. Reused verbatim
    // below when persisting pipeline_loads.carrier_agreed_currency so the
    // persisted currency always matches whatever carrier_profit was actually
    // computed in — never derived independently from metadata.currency (the
    // webhook payload's currency), which can diverge from the load's real
    // agreed_rate_currency (whole-branch review finding 3).
    let carrierCurrency: 'CAD' | 'USD' = 'CAD';

    if (parsed.outcome === 'accept' && parsed.agreedRate !== null) {
      const loadRow = await db.query<{ agreed_rate: string | null; agreed_rate_currency: string | null }>(
        `SELECT agreed_rate, agreed_rate_currency FROM pipeline_loads WHERE id = $1`,
        [pipelineLoadId],
      );
      const agreedShipperRate = Number(loadRow.rows[0]?.agreed_rate ?? 0);
      carrierCurrency = (loadRow.rows[0]?.agreed_rate_currency as 'CAD' | 'USD') ?? 'CAD';

      const { calculateCarrierNegotiationParams } = await import('./cost-calculator');
      const envelope = calculateCarrierNegotiationParams(agreedShipperRate, carrierCurrency);

      if (parsed.agreedRate > envelope.ceiling) {
        finalOutcome = 'escalated';
      } else {
        carrierProfit = agreedShipperRate - parsed.agreedRate;
      }
    }

    await db.query(
      `INSERT INTO agent_calls (
         pipeline_load_id, call_id, call_type, persona, language, currency,
         retell_call_id, retell_agent_id, phone_number_called,
         call_initiated_at, call_ended_at, duration_seconds,
         carrier_outcome, carrier_agreed_rate, carrier_profit,
         transcript, recording_url, created_at
       ) VALUES (
         $1, $2, 'outbound_carrier', $3, $4, $5,
         $6, $7, $8,
         $9, NOW(), $10,
         $11, $12, $13,
         $14, $15, NOW()
       )`,
      [
        pipelineLoadId, payload.call_id, metadata.persona, metadata.language, metadata.currency,
        metadata.retellCallId, metadata.retellAgentId, metadata.toNumber,
        metadata.startTime, metadata.durationSeconds,
        finalOutcome, finalOutcome === 'accept' ? parsed.agreedRate : null,
        finalOutcome === 'accept' ? carrierProfit : null,
        (payload as any).transcript ?? null, metadata.recordingUrl ?? null,
      ],
    );

    await db.query(
      `UPDATE pipeline_loads
       SET carrier_call_outcome = $2,
           carrier_agreed_rate = $3,
           carrier_agreed_currency = $4,
           carrier_profit = $5,
           updated_at = NOW()
       WHERE id = $1`,
      [
        pipelineLoadId, finalOutcome,
        finalOutcome === 'accept' ? parsed.agreedRate : null,
        finalOutcome === 'accept' ? carrierCurrency : null,
        finalOutcome === 'accept' ? carrierProfit : null,
      ],
    );

    if (finalOutcome === 'decline') {
      return enqueueCascadeStep(payload, metadata, 'decline');
    }

    return {
      success: true,
      pipelineLoadId,
      callId: payload.call_id,
      outcome: finalOutcome,
      nextAction: finalOutcome === 'accept' ? 'send_confirmation' : finalOutcome === 'escalated' ? 'escalate_human' : 'no_action',
      details: { carrierOutcome: finalOutcome, carrierAgreedRate: finalOutcome === 'accept' ? parsed.agreedRate : null },
      timestamp: new Date(),
    };
  } catch (error) {
    console.error('[WEBHOOK] Error processing completed carrier call:', {
      callId: payload.call_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      pipelineLoadId,
      callId: payload.call_id,
      outcome: 'error',
      nextAction: 'escalate_human',
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date(),
    };
  }
}

/**
 * Non-'completed' carrier call statuses (no_answer / voicemail / busy /
 * failed). Maps them onto decideCascadeAction()'s outcome vocabulary and
 * drives the cascade forward - this is the branch that didn't exist before
 * E2-03 M2 Session 2 (every such call previously fell through to
 * 'carrier_status_unhandled' and escalated immediately, per the whole-branch
 * review finding that shipped alongside M2 Foundation).
 */
export async function processCarrierCallOutcome(
  payload: RetellWebhookPayload,
  metadata: CallMetadata,
): Promise<ProcessResult> {
  const { pipelineLoadId } = metadata;

  const outcomeMap: Record<string, import('./carrier-cascade').CarrierCascadeOutcome> = {
    voicemail: 'voicemail',
    no_answer: 'no_answer',
    busy: 'busy',
    // No literal 'disconnected' call_status in this codebase's Retell
    // payload type - PRD section 6.3's "disconnected" maps onto 'failed' (a
    // call that didn't complete), documented in the M2 cascade plan's
    // Global Constraints.
    failed: 'disconnected',
  };
  const outcome = outcomeMap[payload.call_status];

  await db.query(
    `INSERT INTO agent_calls (
       pipeline_load_id, call_id, call_type, persona, language, currency,
       retell_call_id, retell_agent_id, phone_number_called,
       call_initiated_at, call_ended_at, duration_seconds,
       carrier_outcome, created_at
     ) VALUES (
       $1, $2, 'outbound_carrier', $3, $4, $5,
       $6, $7, $8,
       $9, NOW(), $10,
       $11, NOW()
     )`,
    [
      pipelineLoadId, payload.call_id, metadata.persona, metadata.language, metadata.currency,
      metadata.retellCallId, metadata.retellAgentId, metadata.toNumber,
      metadata.startTime, metadata.durationSeconds, outcome,
    ],
  );

  await db.query(
    `UPDATE pipeline_loads SET carrier_call_outcome = $2, updated_at = NOW() WHERE id = $1`,
    [pipelineLoadId, outcome],
  );

  return enqueueCascadeStep(payload, metadata, outcome);
}

/**
 * Shared by processCarrierCallCompleted()'s decline branch and
 * processCarrierCallOutcome() above. Reads cascade position/retry
 * count/stack length back out of the metadata the worker set when it
 * dialed, calls the pure decideCascadeAction(), and either re-enqueues
 * carrier-call-queue (advance/retry) or escalates (exhausted).
 */
async function enqueueCascadeStep(
  payload: RetellWebhookPayload,
  metadata: CallMetadata,
  outcome: import('./carrier-cascade').CarrierCascadeOutcome,
): Promise<ProcessResult> {
  const { decideCascadeAction, escalateCascadeExhausted } = await import('./carrier-cascade');
  const { pipelineLoadId, cascadePosition, voicemailRetryCount, stackLength } = metadata;

  if (cascadePosition === undefined || stackLength === undefined) {
    // Defensive - should never happen for a real carrier call, which the
    // worker always stamps with cascade metadata before dialing.
    return {
      success: false,
      pipelineLoadId,
      callId: payload.call_id,
      outcome,
      nextAction: 'escalate_human',
      error: 'Carrier call webhook missing cascade metadata (cascadePosition/stackLength)',
      timestamp: new Date(),
    };
  }

  const action = decideCascadeAction({
    outcome,
    position: cascadePosition,
    stackLength,
    voicemailRetryCount: voicemailRetryCount ?? 0,
  });

  if (action.type === 'accept') {
    // processCarrierCallCompleted() already handled the terminal write for
    // an accept before calling this helper - nothing left to enqueue.
    return {
      success: true, pipelineLoadId, callId: payload.call_id, outcome,
      nextAction: 'no_action', timestamp: new Date(),
    };
  }

  const loadRow = await db.query<{
    load_id: string; load_board_source: string;
    origin_city: string; origin_state: string; destination_city: string; destination_state: string;
  }>(
    `SELECT load_id, load_board_source, origin_city, origin_state, destination_city, destination_state
     FROM pipeline_loads WHERE id = $1`,
    [pipelineLoadId],
  );
  const load = loadRow.rows[0];

  if (action.type === 'exhausted') {
    const stackRow = await db.query<{ carrier_id: string }>(
      `SELECT carrier_id FROM match_results WHERE load_id = $1 ORDER BY match_score DESC LIMIT $2`,
      [load.load_id, stackLength],
    );
    await escalateCascadeExhausted({
      pipelineLoadId, loadId: load.load_id,
      stack: stackRow.rows.map((r) => r.carrier_id),
      originCity: load.origin_city, originState: load.origin_state,
      destinationCity: load.destination_city, destinationState: load.destination_state,
    });
    return {
      success: true, pipelineLoadId, callId: payload.call_id, outcome,
      nextAction: 'escalate_human',
      details: { cascadeExhausted: true },
      timestamp: new Date(),
    };
  }

  const nextPosition = action.type === 'advance' ? action.nextPosition : action.position;
  const nextRetryCount = action.type === 'retry_same' ? (voicemailRetryCount ?? 0) + 1 : 0;
  const jobOptions = action.type === 'retry_same' ? { delay: action.delayMs } : {};

  await carrierCallQueue.add(
    'cascade-step',
    {
      pipelineLoadId,
      loadId: load.load_id,
      loadBoardSource: load.load_board_source,
      enqueuedAt: new Date().toISOString(),
      priority: 5,
      cascadePosition: nextPosition,
      voicemailRetryCount: nextRetryCount,
    },
    jobOptions,
  );

  return {
    success: true, pipelineLoadId, callId: payload.call_id, outcome,
    nextAction: action.type === 'retry_same' ? 'retry_later' : 'no_action',
    details: { cascadeAction: action.type, nextPosition, nextRetryCount },
    timestamp: new Date(),
  };
}

/**
 * Process a failed call (network error, Retell error, etc.)
 *
 * @param payload - Retell webhook payload
 * @param metadata - Extracted call metadata
 * @returns ProcessResult marking escalation
 */
export async function processCallFailed(
  payload: RetellWebhookPayload,
  metadata: CallMetadata
): Promise<ProcessResult> {
  const { pipelineLoadId } = metadata;

  console.warn('[WEBHOOK] Call failed:', {
    callId: payload.call_id,
    callStatus: payload.call_status,
  });

  // Update pipeline load
  await updatePipelineLoad(pipelineLoadId, {
    id: pipelineLoadId,
    stage: 'escalated',
    stage_updated_at: new Date(),
    call_attempts: await getCallAttempts(pipelineLoadId),
    last_call_at: new Date(),
    call_outcome: 'call_failed',
    agreed_rate: null,
    agreed_rate_currency: null,
    profit: null,
    profit_margin_pct: null,
    auto_booked: false,
    booked_at: null,
    tms_load_id: null,
  });

  // Enqueue to escalation
  await escalationQueue.add(
    'escalate',
    {
      pipelineLoadId,
      reason: 'Call failed due to Retell/network error',
      callId: payload.call_id,
      details: {
        callStatus: payload.call_status,
        duration: payload.duration_ms,
      },
      timestamp: new Date().toISOString(),
    } as EscalationQueuePayload
  );

  return {
    success: true,
    pipelineLoadId,
    callId: payload.call_id,
    outcome: 'call_failed',
    nextAction: 'escalate_human',
    timestamp: new Date(),
  };
}

/**
 * Process non-conversation outcomes (no answer, voicemail, busy).
 *
 * Logic:
 * - If attempts < maxAttempts: retry with delay
 * - If attempts >= maxAttempts: mark as declined
 *
 * @param payload - Retell webhook payload
 * @param metadata - Extracted call metadata
 * @returns ProcessResult with retry or decline decision
 */
export async function processNonConversation(
  payload: RetellWebhookPayload,
  metadata: CallMetadata
): Promise<ProcessResult> {
  const { pipelineLoadId, briefId } = metadata;
  const maxAttempts = 2;

  console.log('[WEBHOOK] Non-conversation outcome:', {
    callId: payload.call_id,
    status: payload.call_status,
  });

  const currentAttempts = await getCallAttempts(pipelineLoadId);

  if (currentAttempts < maxAttempts) {
    // Schedule retry
    const delay =
      payload.call_status === 'no_answer'
        ? 3600000 // 1 hour
        : payload.call_status === 'voicemail'
        ? 1800000 // 30 minutes
        : 900000; // 15 minutes for busy

    await retryQueue.add(
      'retry-call',
      {
        pipelineLoadId,
        briefId,
        phoneNumber: payload.to_number,
        retryCount: currentAttempts + 1,
        timestamp: new Date().toISOString(),
      } as RetryQueuePayload,
      { delay }
    );

    return {
      success: true,
      pipelineLoadId,
      callId: payload.call_id,
      outcome: payload.call_status,
      nextAction: 'retry_later',
      details: {
        retryAttempt: currentAttempts + 1,
        delayMs: delay,
      },
      timestamp: new Date(),
    };
  } else {
    // Max retries reached — mark as declined
    await updatePipelineLoad(pipelineLoadId, {
      id: pipelineLoadId,
      stage: 'declined',
      stage_updated_at: new Date(),
      call_attempts: currentAttempts + 1,
      last_call_at: new Date(),
      call_outcome: payload.call_status,
      agreed_rate: null,
      agreed_rate_currency: null,
      profit: null,
      profit_margin_pct: null,
      auto_booked: false,
      booked_at: null,
      tms_load_id: null,
    });

    return {
      success: true,
      pipelineLoadId,
      callId: payload.call_id,
      outcome: payload.call_status,
      nextAction: 'no_action',
      details: {
        maxAttemptsReached: true,
        totalAttempts: currentAttempts + 1,
      },
      timestamp: new Date(),
    };
  }
}

// ============================================================================
// HELPER: EXTRACT CALL METADATA
// ============================================================================

/**
 * Extract call metadata from Retell webhook payload.
 * Combines metadata object, call timing, and call details.
 *
 * @param payload - Retell webhook payload
 * @returns CallMetadata object
 */
export function extractCallMetadata(
  payload: RetellWebhookPayload
): CallMetadata {
  return {
    pipelineLoadId: payload.metadata.pipelineLoadId,
    briefId: payload.metadata.briefId,
    persona: payload.metadata.persona,
    language: payload.metadata.language,
    currency: payload.metadata.currency,
    fromNumber: payload.from_number,
    toNumber: payload.to_number,
    durationSeconds: Math.round(payload.duration_ms / 1000),
    startTime: new Date(payload.start_time),
    endTime: new Date(payload.end_time),
    recordingUrl: payload.recording_url,
    retellCallId: payload.call_id,
    retellAgentId: payload.agent_id,
    // E2-03 M2: absent on every existing shipper call (voice-worker.ts never
    // sets it), so this default preserves that path exactly. carrier-voice-
    // worker.ts sets it explicitly when it dials.
    callType: payload.metadata.callType ?? 'outbound_shipper',
    cascadePosition: payload.metadata.cascadePosition,
    voicemailRetryCount: payload.metadata.voicemailRetryCount,
    carrierId: payload.metadata.carrierId,
    stackLength: payload.metadata.stackLength,
  };
}

// ============================================================================
// HELPER: PARSE CALL TRANSCRIPT (Call Parser Integration)
// ============================================================================

/**
 * Call Claude API to analyze transcript and extract structured data.
 *
 * This function calls the claude-service.parseCall() from BUILD 3.
 * It returns a structured CallResult that's ready to write to the database.
 *
 * @param transcript - Full call transcript
 * @param brief - Negotiation brief used for the call
 * @param metadata - Call metadata for context
 * @param payload - Original Retell webhook payload
 * @returns CallResult with parsed outcome and details
 */
async function parseCall(
  transcript: string,
  brief: any,
  metadata: CallMetadata,
  payload: RetellWebhookPayload
): Promise<CallResult> {
  // Import claude-service from BUILD 3
  const { ClaudeService } = await import('@/lib/pipeline/claude-service');
  const service = new ClaudeService();

  const callResult = await service.parseCall(
    {
      loadId: brief.load?.loadId || '',
      originCity: brief.load?.origin?.city || '',
      originState: brief.load?.origin?.state || '',
      destinationCity: brief.load?.destination?.city || '',
      destinationState: brief.load?.destination?.state || '',
      equipmentType: brief.load?.equipmentType || '',
      initialOffer: brief.negotiation?.initialOffer || 0,
      minAcceptableRate: brief.negotiation?.walkAwayRate || 0,
      persona: metadata.persona,
      language: metadata.language,
    } as any,
    transcript,
    String(metadata.pipelineLoadId),
  ) as unknown as CallResult;

  return callResult;
}

// ============================================================================
// HELPER: WRITE AGENT CALL RECORD
// ============================================================================

/**
 * Write call record to agent_calls table.
 *
 * @param payload - Retell webhook payload
 * @param result - Parsed call result from Claude
 * @param metadata - Call metadata
 * @param brief - Negotiation brief used
 */
async function writeAgentCall(
  payload: RetellWebhookPayload,
  result: CallResult,
  metadata: CallMetadata,
  brief: any
): Promise<void> {
  const callbackScheduledAt =
    result.outcome === 'callback' && result.callback_details.requested
      ? parseCallbackTime(result.callback_details)
      : null;

  const record: AgentCallRecord = {
    pipeline_load_id: metadata.pipelineLoadId,
    call_id: payload.call_id,
    call_type: 'outbound_shipper',
    persona: metadata.persona,
    language: metadata.language,
    currency: metadata.currency,
    retell_call_id: payload.call_id,
    retell_agent_id: payload.agent_id,
    phone_number_called: payload.to_number,
    call_initiated_at: metadata.startTime,
    call_ended_at: metadata.endTime,
    duration_seconds: metadata.durationSeconds,
    negotiation_brief_id: metadata.briefId,
    initial_offer: brief.negotiation?.initialOffer || null,
    min_acceptable_rate: brief.negotiation?.walkAwayRate || null,
    target_rate: brief.negotiation?.targetOffer || null,
    outcome: result.outcome,
    agreed_rate: result.final_rate,
    profit: result.profit,
    profit_tier: result.profit_tier,
    auto_book_eligible: result.auto_book_eligible,
    sentiment: result.sentiment,
    objections: result.objections,
    concessions_made: result.concessions_made,
    next_action: result.next_action,
    callback_scheduled_at: callbackScheduledAt,
    decision_maker_name: result.decision_maker_referral.name,
    decision_maker_phone: result.decision_maker_referral.phone,
    decision_maker_email: result.decision_maker_referral.email,
    transcript: payload.transcript,
    recording_url: payload.recording_url,
    call_analysis: result as any,
    call_quality_score: null,
  };

  await db.query(
    `INSERT INTO agent_calls (
      pipeline_load_id, call_id, call_type, persona, language, currency,
      retell_call_id, retell_agent_id, phone_number_called,
      call_initiated_at, call_ended_at, duration_seconds,
      negotiation_brief_id, initial_offer, min_acceptable_rate, target_rate,
      outcome, agreed_rate, profit, profit_tier, auto_book_eligible,
      sentiment, objections, concessions_made,
      next_action, callback_scheduled_at,
      decision_maker_name, decision_maker_phone, decision_maker_email,
      transcript, recording_url, call_analysis
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31
    )`,
    [
      record.pipeline_load_id,
      record.call_id,
      record.call_type,
      record.persona,
      record.language,
      record.currency,
      record.retell_call_id,
      record.retell_agent_id,
      record.phone_number_called,
      record.call_initiated_at,
      record.call_ended_at,
      record.duration_seconds,
      record.negotiation_brief_id,
      record.initial_offer,
      record.min_acceptable_rate,
      record.target_rate,
      record.outcome,
      record.agreed_rate,
      record.profit,
      record.profit_tier,
      record.auto_book_eligible,
      record.sentiment,
      JSON.stringify(record.objections),
      record.concessions_made,
      record.next_action,
      record.callback_scheduled_at,
      record.decision_maker_name,
      record.decision_maker_phone,
      record.decision_maker_email,
      record.transcript,
      record.recording_url,
      JSON.stringify(record.call_analysis),
    ]
  );
}

// ============================================================================
// HELPER: DETERMINE PIPELINE STAGE FROM CALL OUTCOME
// ============================================================================

/**
 * Map call outcome to next pipeline stage and update details.
 *
 * Mapping (from T-12):
 * - booked + auto_book_eligible → booked
 * - booked + !auto_book_eligible → escalated
 * - declined → declined
 * - callback → calling (stays)
 * - voicemail, no_answer → calling (stays) or declined
 * - wrong_contact → escalated (or declined if no referral)
 * - escalated → escalated
 * - dropped → calling (retry)
 *
 * @param result - Parsed call result
 * @returns Pipeline stage update object
 */
function determinePipelineStage(result: CallResult): PipelineLoadUpdate {
  let stage = 'escalated'; // default safe state

  switch (result.outcome) {
    case 'booked':
      stage = result.auto_book_eligible ? 'booked' : 'escalated';
      break;
    case 'declined':
      stage = 'declined';
      break;
    case 'callback':
      stage = 'calling'; // stays in calling, delayed job will retry
      break;
    case 'no_answer':
    case 'voicemail':
    case 'dropped':
      stage = 'calling'; // stays, will be retried
      break;
    case 'wrong_contact':
      stage = result.decision_maker_referral.provided ? 'escalated' : 'declined';
      break;
    case 'escalated':
    case 'counter_pending':
      stage = 'escalated';
      break;
  }

  return {
    id: 0, // Will be filled from context
    stage,
    stage_updated_at: new Date(),
    call_attempts: 0, // Will be incremented in actual update
    last_call_at: new Date(),
    call_outcome: result.outcome,
    agreed_rate: result.final_rate,
    agreed_rate_currency: result.final_rate_currency,
    profit: result.profit,
    profit_margin_pct: result.profit
      ? Math.round((result.profit / (result.final_rate || 1)) * 100)
      : null,
    auto_booked: result.auto_book_eligible && result.outcome === 'booked',
    booked_at: result.outcome === 'booked' ? new Date() : null,
    tms_load_id: null,
    // E2-04 M0 — raw pass-through, only meaningful on a booked outcome.
    // Validation + the missing/malformed-email escalation happens in
    // ShipperConfirmationWorker, not here, so that check lives in one place.
    shipper_email: result.outcome === 'booked' ? result.shipper_email : null,
  };
}

// ============================================================================
// HELPER: UPDATE PIPELINE LOAD
// ============================================================================

/**
 * Update pipeline_loads table with call results.
 *
 * @param pipelineLoadId - Load ID to update
 * @param update - Fields to update
 */
async function updatePipelineLoad(
  pipelineLoadId: number,
  update: Partial<PipelineLoadUpdate>
): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (update.stage !== undefined) {
    fields.push(`stage = $${paramIndex++}`);
    values.push(update.stage);
  }
  if (update.stage_updated_at !== undefined) {
    fields.push(`stage_updated_at = $${paramIndex++}`);
    values.push(update.stage_updated_at);
  }
  if (update.call_attempts !== undefined) {
    fields.push(`call_attempts = call_attempts + 1`);
  }
  if (update.last_call_at !== undefined) {
    fields.push(`last_call_at = $${paramIndex++}`);
    values.push(update.last_call_at);
  }
  if (update.call_outcome !== undefined) {
    fields.push(`call_outcome = $${paramIndex++}`);
    values.push(update.call_outcome);
  }
  if (update.agreed_rate !== undefined) {
    fields.push(`agreed_rate = $${paramIndex++}`);
    values.push(update.agreed_rate);
  }
  if (update.agreed_rate_currency !== undefined) {
    fields.push(`agreed_rate_currency = $${paramIndex++}`);
    values.push(update.agreed_rate_currency);
  }
  if (update.profit !== undefined) {
    fields.push(`profit = $${paramIndex++}`);
    values.push(update.profit);
  }
  if (update.profit_margin_pct !== undefined) {
    fields.push(`profit_margin_pct = $${paramIndex++}`);
    values.push(update.profit_margin_pct);
  }
  if (update.auto_booked !== undefined) {
    fields.push(`auto_booked = $${paramIndex++}`);
    values.push(update.auto_booked);
  }
  if (update.booked_at !== undefined) {
    fields.push(`booked_at = $${paramIndex++}`);
    values.push(update.booked_at);
  }
  if (update.shipper_email !== undefined) {
    fields.push(`shipper_email = $${paramIndex++}`);
    values.push(update.shipper_email);
  }

  if (fields.length === 0) {
    return;
  }

  values.push(pipelineLoadId);

  await db.query(
    `UPDATE pipeline_loads SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
    values
  );
}

// ============================================================================
// HELPER: ENQUEUE NEXT ACTION
// ============================================================================

/**
 * Enqueue the next action based on call outcome.
 *
 * - booked + auto → dispatch-queue
 * - callback → callback-queue with delay
 * - escalated → escalation-queue
 * - declined → no enqueue (terminal)
 *
 * @param outcome - Call outcome
 * @param pipelineLoadId - Load ID
 * @param callId - Call ID
 * @param metadata - Call metadata
 * @param result - Parsed call result
 */
async function enqueueNextAction(
  outcome: string,
  pipelineLoadId: number,
  callId: string,
  metadata: CallMetadata,
  result: CallResult
): Promise<void> {
  const timestamp = new Date().toISOString();

  switch (outcome) {
    case 'booked':
      if (result.auto_book_eligible) {
        // E2-04 M2: a booked, auto-book-eligible load no longer goes
        // straight to dispatch-queue. It first needs written confirmation
        // from the shipper -- ShipperConfirmationWorker's 'send' action
        // handles the email/PDF/token, advances the stage, and self-
        // schedules the nudge/escalate follow-ups. dispatch-queue is
        // triggered later, once a carrier is secured (E2-04 M5/M6).
        await shipperConfirmationQueue.add('send', {
          pipelineLoadId,
          loadId: '',
          loadBoardSource: '',
          enqueuedAt: timestamp,
          priority: Math.floor((result.profit || 0) / 100),
          action: 'send',
        });
      } else {
        // Below threshold — escalate
        const escalatePayload: EscalationQueuePayload = {
          pipelineLoadId,
          reason: 'Booked but profit below auto-book threshold',
          callId,
          details: {
            agreedRate: result.final_rate,
            profit: result.profit,
            profitTier: result.profit_tier,
          },
          timestamp,
        };
        await escalationQueue.add('review', escalatePayload);
      }
      break;

    case 'callback':
      if (result.callback_details.requested && result.callback_details.day) {
        const callbackTime = parseCallbackTime(result.callback_details);
        const delayMs = callbackTime.getTime() - Date.now();

        const callbackPayload: CallbackQueuePayload = {
          pipelineLoadId,
          briefId: metadata.briefId,
          phoneNumber: metadata.toNumber,
          callbackTime: callbackTime.toISOString(),
          timestamp,
        };
        await callbackQueue.add('callback', callbackPayload, {
          delay: Math.max(delayMs, 0),
          priority: 1, // High priority for warm leads
        });
      }
      break;

    case 'escalated':
    case 'counter_pending':
      const escalatePayload: EscalationQueuePayload = {
        pipelineLoadId,
        reason:
          outcome === 'counter_pending'
            ? 'Counter-offer outside acceptable range'
            : result.analysis_notes,
        callId,
        details: { outcome, finalRate: result.final_rate },
        timestamp,
      };
      await escalationQueue.add('review', escalatePayload);
      break;

    case 'declined':
    case 'wrong_contact':
      // Terminal states — no further action
      break;
  }
}

// ============================================================================
// HELPER: UPDATE SHIPPER PREFERENCES
// ============================================================================

/**
 * Update shipper_preferences table with learning data from the call.
 *
 * @param phone - Shipper phone number
 * @param result - Parsed call result
 * @param metadata - Call metadata
 */
async function updateShipperPreferences(
  phone: string,
  result: CallResult,
  metadata: CallMetadata
): Promise<void> {
  const update: ShipperPreferencesUpdate = {
    phone,
    preferredLanguage: metadata.language,
    preferredCurrency: metadata.currency,
  };

  // Upsert shipper preferences
  await db.query(
    `INSERT INTO shipper_preferences (
      phone, preferred_language, preferred_currency, total_calls_received, last_objection_type
    ) VALUES ($1, $2, $3, 1, $4)
    ON CONFLICT (phone) DO UPDATE SET
      preferred_language = COALESCE($2, shipper_preferences.preferred_language),
      preferred_currency = COALESCE($3, shipper_preferences.preferred_currency),
      total_calls_received = shipper_preferences.total_calls_received + 1,
      last_objection_type = $4,
      updated_at = NOW()`,
    [
      phone,
      update.preferredLanguage,
      update.preferredCurrency,
      result.objections[0] || null,
    ]
  );

  // If booked, update booking stats
  if (result.outcome === 'booked') {
    await db.query(
      `UPDATE shipper_preferences SET
        total_bookings = COALESCE(total_bookings, 0) + 1,
        best_performing_persona = $2,
        updated_at = NOW()
      WHERE phone = $1`,
      [phone, metadata.persona]
    );
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get current call attempts for a load
 *
 * @param pipelineLoadId - Load ID
 * @returns Current attempt count
 */
async function getCallAttempts(pipelineLoadId: number): Promise<number> {
  const result = await db.query(
    'SELECT call_attempts FROM pipeline_loads WHERE id = $1',
    [pipelineLoadId]
  );
  return result.rows.length > 0 ? result.rows[0].call_attempts : 0;
}

/**
 * Parse callback time from result details.
 * Converts day + time + timezone to absolute Date.
 *
 * @param details - Callback details from parser
 * @returns Date object for callback time
 */
function parseCallbackTime(details: {
  day?: string | null;
  time?: string | null;
  timezone?: string | null;
}): Date {
  // Simplified: if details provided, schedule for tomorrow at 9 AM
  // In production, parse day/time/timezone properly
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow;
}

/**
 * Audit log entry for compliance and debugging.
 *
 * @param entry - Log entry
 */
async function auditLog(entry: AuditLogEntry): Promise<void> {
  try {
    await db.query(
      `INSERT INTO compliance_audit (
        phone, check_type, result, details, pipeline_load_id, call_id, checked_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.phone,
        entry.eventType,
        entry.severity,
        JSON.stringify(entry.details),
        entry.pipelineLoadId,
        entry.callId,
        entry.timestamp,
      ]
    );
  } catch (error) {
    console.warn('[AUDIT] Failed to log:', error);
    // Don't fail the webhook on audit log failure
  }
}

export default handleRetellWebhook;
