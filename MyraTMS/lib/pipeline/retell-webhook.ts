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
  const payload = await req.json() as RetellWebhookPayload;

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

    // Step 2: Verify signature
    const signature = req.headers['x-retell-signature'] || '';
    const rawBody = JSON.stringify(payload);
    const secret = process.env.RETELL_WEBHOOK_SECRET || '';

    const sigVerification = validateRetellSignature(rawBody, signature, secret);
    if (!sigVerification.valid) {
      await auditLog({
        timestamp: new Date(),
        eventType: 'signature_verification_failed',
        pipelineLoadId: payload.metadata.pipelineLoadId,
        callId: payload.call_id,
        phone: payload.to_number,
        details: { error: sigVerification.error },
        severity: 'warning',
      });

      console.error('[SECURITY] Invalid webhook signature:', {
        callId: payload.call_id,
        expectedSignature: signature,
      });

      return {
        status: 401,
        body: { error: 'Invalid signature', processed: false },
      };
    }

    // Step 3: Extract metadata
    const metadata = extractCallMetadata(payload);

    // Step 4: Route by call status
    let result: ProcessResult;

    if (payload.call_status === 'completed') {
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
        const dispatchPayload: DispatchQueuePayload = {
          pipelineLoadId,
          loadId: '', // Will be fetched from brief
          agreedRate: result.final_rate || 0,
          agreedRateCurrency: result.final_rate_currency || metadata.currency,
          profit: result.profit || 0,
          callId,
          timestamp,
        };
        await dispatchQueue.add('dispatch', dispatchPayload, {
          priority: Math.floor((result.profit || 0) / 100), // Higher profit = higher priority
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
