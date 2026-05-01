/**
 * AGENT 6 - VOICE AGENT WORKER (RETELL AI)
 *
 * Initiates phone calls via Retell AI. Receives a negotiation brief from Agent 5,
 * injects it as dynamic context into the Retell agent, and initiates the call.
 * Handles non-conversation outcomes (no answer, voicemail, etc.) with retry logic.
 *
 * The actual call happens asynchronously via Retell - this worker just initiates it.
 * Call results come back via webhook (/api/webhooks/retell-callback) and are processed
 * by a separate webhook handler that advances the pipeline.
 *
 * Input: call-queue with CallJobPayload
 * Output: Call initiated on Retell, call_id stored, call_attempts incremented
 * Next Stage: Webhook handles result (booked/declined/callback/etc.)
 */

import { Job } from 'bullmq';
import Redis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

/**
 * Call job payload - received from Agent 5 (Compiler)
 */
export interface CallJobPayload extends BaseJobPayload {
  briefId: number;
  brief: any; // NegotiationBrief - complete JSON
  retellAgentId: string;
  phoneNumber: string;
  language: string;
}

/**
 * Voice worker - Retell AI call initiation
 */
export class VoiceWorker extends BaseWorker<CallJobPayload> {
  private retellApiKey: string;
  private outboundNumbers: string[]; // Rotating phone numbers

  constructor(redis: Redis, retellApiKey: string, outboundNumbers: string[]) {
    const config: WorkerConfig = {
      queueName: 'call-queue',
      expectedStage: 'briefed',
      nextStage: 'calling',
      concurrency: 100, // Retell supports many concurrent calls
      retryConfig: {
        attempts: 1, // No retry on voice calls - calls fail for business reasons, not transient errors
        backoff: {
          type: 'fixed',
          delay: 0,
        },
      },
      redis,
    };

    super(config);
    this.retellApiKey = retellApiKey;
    this.outboundNumbers = outboundNumbers;
  }

  /**
   * Main voice call initiation logic
   */
  public async process(payload: CallJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId, briefId, brief, phoneNumber, retellAgentId, language } = payload;
    logger.debug(`[Voice] Initiating call for load ${pipelineLoadId}, brief ${briefId}`);

    try {
      // Check rate limiting per area code
      await this.checkAreaCodeRateLimit(phoneNumber);

      // Initiate Retell call with dynamic context injection
      const callId = await this.initiateRetellCall({
        brief,
        retellAgentId,
        phoneNumber,
        language,
        metadata: {
          pipelineLoadId,
          briefId,
          persona: brief.persona.personaName,
          language,
          currency: brief.rates.currency,
        },
      });

      logger.info(
        `[Voice] Call initiated for load ${pipelineLoadId}. Retell call_id: ${callId}, to: ${phoneNumber}`
      );

      return {
        success: true,
        pipelineLoadId,
        stage: this.config.expectedStage,
        duration: 0,
        details: {
          callId,
          phoneNumber,
          persona: brief.persona.personaName,
          strategy: brief.strategy.approach,
        },
      };
    } catch (error) {
      logger.error(`[Voice] Error initiating call for load ${pipelineLoadId}:`, error);
      throw error;
    }
  }

  /**
   * Initiate a call via Retell AI API
   */
  private async initiateRetellCall(params: {
    brief: any;
    retellAgentId: string;
    phoneNumber: string;
    language: string;
    metadata: any;
  }): Promise<string> {
    try {
      // TODO: Select a rotating outbound number (load balance across available numbers)
      const outboundNumber = this.selectOutboundNumber();

      // TODO: Build dynamic variables from brief
      // These are injected into the Retell agent prompt via {{variable_name}} syntax
      const dynamicVariables = this.buildDynamicVariables(params.brief);

      // Call Retell API to initiate phone call
      const response = await fetch('https://api.retellai.com/v2/create-phone-call', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.retellApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from_number: outboundNumber,
          to_number: params.phoneNumber,
          agent_id: params.retellAgentId,
          retell_llm_dynamic_variables: dynamicVariables,
          metadata: params.metadata,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`Retell API error: ${JSON.stringify(error)}`);
      }

      const data = await response.json();
      return data.call_id;
    } catch (error) {
      logger.error('[Voice] Failed to initiate Retell call:', error);
      throw error;
    }
  }

  /**
   * Build dynamic variables to inject into Retell agent prompt
   * These are {{variable_name}} placeholders in the agent prompt template
   */
  private buildDynamicVariables(brief: any): Record<string, string> {
    // TODO: Extract all necessary fields from brief
    // See T-09 Section 2 for complete list

    return {
      agent_name: 'Sarah', // Consistent human-sounding name
      brokerage_name: 'Myra Logistics',
      load_id: brief.load.loadId,
      load_board_source: brief.load.loadBoardSource,
      pickup_city: brief.load.origin.city,
      pickup_state: brief.load.origin.state,
      delivery_city: brief.load.destination.city,
      delivery_state: brief.load.destination.state,
      pickup_date: brief.load.pickupDate,
      delivery_date: brief.load.deliveryDate || 'flexible',
      equipment_type: brief.load.equipmentType,
      initial_rate: brief.negotiation.initialOffer.toString(),
      concession_step_1: brief.negotiation.concessionStep1.toString(),
      concession_step_2: brief.negotiation.concessionStep2.toString(),
      final_offer: brief.negotiation.finalOffer.toString(),
      min_acceptable_rate: brief.negotiation.walkAwayRate.toString(),
      floor_rate: brief.rates.marketRateFloor.toString(),
      mid_rate: brief.rates.marketRateMid.toString(),
      best_rate: brief.rates.marketRateBest.toString(),
      currency: brief.rates.currency,
      strategy: brief.strategy.approach,
      walk_away_script: brief.negotiation.walkAwayScript,
      disclosure_script: brief.compliance.disclosureScript || '',
    };
  }

  /**
   * Select an outbound phone number (rotate to avoid carrier ID fatigue)
   */
  private selectOutboundNumber(): string {
    // TODO: Implement round-robin or random selection from outboundNumbers array
    return this.outboundNumbers[Math.floor(Math.random() * this.outboundNumbers.length)];
  }

  /**
   * Check rate limiting - don't call the same area code too frequently
   */
  private async checkAreaCodeRateLimit(phoneNumber: string): Promise<void> {
    // TODO: Extract area code from phoneNumber
    // Check how many calls to this area code in the last 5 minutes
    // If > 10 calls/5min, throw error to trigger backoff retry

    // Placeholder implementation:
    const areaCode = phoneNumber.slice(0, 3); // Simplified

    // Query recent calls to same area code
    // const recentCalls = await db.query(`
    //   SELECT COUNT(*) FROM agent_calls
    //   WHERE phone_number_called LIKE $1
    //   AND call_initiated_at > NOW() - INTERVAL '5 minutes'
    // `, [`${areaCode}%`]);

    // if (parseInt(recentCalls.rows[0].count) > 10) {
    //   throw new Error('RATE_LIMIT_AREA'); // BullMQ retries with backoff
    // }
  }

  /**
   * Override updatePipelineLoad to track call initiation
   */
  protected async updatePipelineLoad(pipelineLoadId: number, result: any): Promise<void> {
    try {
      const { callId } = result.details;

      await db.query(
        `UPDATE pipeline_loads
         SET stage = 'calling',
             stage_updated_at = NOW(),
             call_attempts = call_attempts + 1,
             last_call_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [pipelineLoadId]
      );

      // Also insert into agent_calls table with pending status
      // (webhook will update when call completes)
      await db.query(
        `INSERT INTO agent_calls (
          pipeline_load_id, call_id, call_type, retell_call_id,
          call_initiated_at, created_at
        ) VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [pipelineLoadId, callId, 'outbound', callId]
      );

      logger.debug(`[Voice] Pipeline load ${pipelineLoadId} advanced to 'calling'`);
    } catch (error) {
      logger.error(`[Voice] Failed to update pipeline load ${pipelineLoadId}:`, error);
      throw error;
    }
  }
}

/**
 * Webhook handler for Retell call completion
 * This is NOT a worker - it's an API route handler
 * Receives POST from Retell when call completes
 */
export async function handleRetellCallback(payload: any): Promise<void> {
  // TODO: Implement complete webhook handler
  // Steps:
  // 1. Verify Retell signature
  // 2. Parse call outcome from transcript (using Claude API)
  // 3. Update agent_calls table with result
  // 4. Update shipper_preferences from call outcome
  // 5. Update persona metrics for Thompson Sampling
  // 6. Advance pipeline based on call result
  //    - booked: enqueue to dispatch-queue OR escalation-queue (auto-book threshold)
  //    - declined: set stage to 'declined'
  //    - callback: enqueue to callback-queue with delayed time
  //    - escalated: enqueue to escalation-queue for human review
  //    - etc.

  const { pipelineLoadId, briefId, call_status, transcript, metadata } = payload;

  logger.info(
    `[Voice Webhook] Received call result for load ${pipelineLoadId}. Status: ${call_status}`
  );

  // Handle non-conversation outcomes immediately
  if (['no_answer', 'busy', 'voicemail'].includes(call_status)) {
    await handleNonConversation(pipelineLoadId, call_status);
    return;
  }

  // For completed calls: parse transcript and determine outcome
  // TODO: Use Claude API to parse transcript (see T-12)
  // const callResult = await parseCallTranscript(transcript, brief);

  // Update agent_calls with parsed result
  // Update pipeline_loads and advance based on outcome
}

/**
 * Handle non-conversation outcomes with retry logic
 */
async function handleNonConversation(pipelineLoadId: number, callStatus: string): Promise<void> {
  // TODO: Implement non-conversation handling
  // For no_answer / busy / voicemail:
  //   - Check call_attempts
  //   - If < maxAttempts: re-enqueue to call-queue with delay
  //   - If >= maxAttempts: mark as 'declined'

  const maxAttempts = 2;

  const load = await db.query('SELECT call_attempts FROM pipeline_loads WHERE id = $1', [
    pipelineLoadId,
  ]);

  const attempts = load.rows[0]?.call_attempts || 0;

  if (attempts < maxAttempts) {
    // Retry with delay
    const delay = callStatus === 'no_answer' ? 3600000 : 1800000; // 1h or 30min
    logger.info(
      `[Voice] Retrying call for load ${pipelineLoadId} after ${delay}ms. Attempt ${attempts + 1}/${maxAttempts}`
    );
    // TODO: Re-enqueue to call-queue with delay
    // await callQueue.add('retry-call', { pipelineLoadId }, { delay });
  } else {
    // Max attempts reached
    logger.info(`[Voice] Max call attempts reached for load ${pipelineLoadId}. Marking as declined.`);
    await db.query(
      `UPDATE pipeline_loads SET stage = 'declined', stage_updated_at = NOW() WHERE id = $1`,
      [pipelineLoadId]
    );
  }
}

// TODO: Export initialized worker
// export const voiceWorker = new VoiceWorker(redisClient, process.env.RETELL_API_KEY, ['416-555-0001', '705-555-0001']);

// TODO: Export webhook handler for API route
// export { handleRetellCallback, handleNonConversation };
