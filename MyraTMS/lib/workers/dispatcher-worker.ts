/**
 * AGENT 7 - DISPATCHER WORKER
 *
 * Handles everything after a load is booked. Creates the load in MyraTMS,
 * assigns the carrier, generates rate confirmation PDF, sends tracking link,
 * and schedules check-calls. This agent bridges Engine 2 (AI pipeline) with
 * Engine 1 (TMS operations).
 *
 * The full dispatch lifecycle already exists in MyraTMS as API routes.
 * Agent 7's job is to chain these calls together automatically.
 *
 * Input: dispatch-queue with DispatchJobPayload
 * Output: Load created in TMS, carrier assigned, tracking activated
 * Next Stage: dispatched → delivered (when POD captured)
 */

import { Job } from 'bullmq';
import Redis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

/**
 * Dispatch job payload - received from Voice Agent webhook
 */
export interface DispatchJobPayload extends BaseJobPayload {
  agreedRate: number;
  agreedRateCurrency: string;
  profit: number;
  carrierId: number;
  carrierRate: number;
  shipperEmail: string;
  callId: string;
}

/**
 * Dispatcher worker - TMS integration
 */
export class DispatcherWorker extends BaseWorker<DispatchJobPayload> {
  private tmsApiUrl: string;
  private serviceToken: string;

  constructor(redis: Redis, tmsApiUrl: string, serviceToken: string) {
    const config: WorkerConfig = {
      queueName: 'dispatch-queue',
      expectedStage: 'booked',
      nextStage: 'dispatched',
      concurrency: 10, // Lower concurrency - each dispatch involves multiple TMS writes
      retryConfig: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 60000, // 60 seconds
        },
      },
      redis,
    };

    super(config);
    this.tmsApiUrl = tmsApiUrl;
    this.serviceToken = serviceToken;
  }

  /**
   * Main dispatch sequence
   */
  public async process(payload: DispatchJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId, agreedRate, carrierId, carrierRate, shipperEmail, callId } = payload;
    logger.debug(`[Dispatcher] Processing dispatch for load ${pipelineLoadId}`);

    try {
      // Fetch the full pipeline load and carrier data
      const pipelineLoadResult = await db.query(
        'SELECT * FROM pipeline_loads WHERE id = $1',
        [pipelineLoadId]
      );
      const pipelineLoad = pipelineLoadResult.rows[0];

      if (!pipelineLoad) {
        throw new Error(`Pipeline load ${pipelineLoadId} not found`);
      }

      // STEP 1: Create load in TMS
      const tmsLoadId = await this.createTMSLoad(pipelineLoad, agreedRate);

      // STEP 2: Assign carrier
      await this.assignCarrier(tmsLoadId, carrierId, carrierRate);

      // STEP 3: Generate tracking token
      // TODO: Implement tracking token generation

      // STEP 4: Send tracking link to shipper
      if (shipperEmail) {
        await this.sendTrackingLink(tmsLoadId, shipperEmail);
      }

      // STEP 5: Schedule check-calls (existing TMS pattern)
      // TODO: Insert into check-call schedule table

      logger.info(
        `[Dispatcher] Load ${pipelineLoadId} dispatched. TMS load_id: ${tmsLoadId}, agreed rate: $${agreedRate}, profit: $${payload.profit}`
      );

      return {
        success: true,
        pipelineLoadId,
        stage: this.config.expectedStage,
        duration: 0,
        details: {
          tmsLoadId,
          carrierId,
          agreedRate,
          profit: payload.profit,
        },
      };
    } catch (error) {
      logger.error(`[Dispatcher] Error dispatching load ${pipelineLoadId}:`, error);
      throw error;
    }
  }

  /**
   * Create load in TMS via API
   */
  private async createTMSLoad(pipelineLoad: any, agreedRate: number): Promise<string> {
    try {
      // TODO: Call existing POST /api/loads endpoint

      const response = await fetch(`${this.tmsApiUrl}/api/loads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `auth-token=${this.serviceToken}`,
        },
        body: JSON.stringify({
          origin: `${pipelineLoad.origin_city}, ${pipelineLoad.origin_state}`,
          destination: `${pipelineLoad.destination_city}, ${pipelineLoad.destination_state}`,
          revenue: agreedRate,
          equipment: pipelineLoad.equipment_type,
          commodity: pipelineLoad.commodity,
          weight: pipelineLoad.weight_lbs?.toString() || '',
          pickup_date: pipelineLoad.pickup_date,
          delivery_date: pipelineLoad.delivery_date,
          source: 'Load Board',
          status: 'Booked',
          // Link back to pipeline
          pipeline_load_id: pipelineLoad.id,
          source_type: 'ai_agent',
          booked_via: 'ai_auto',
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`TMS API error creating load: ${JSON.stringify(error)}`);
      }

      const tmsLoad = await response.json();
      return tmsLoad.id;
    } catch (error) {
      logger.error('[Dispatcher] Failed to create TMS load:', error);
      throw error;
    }
  }

  /**
   * Assign carrier to load in TMS
   */
  private async assignCarrier(tmsLoadId: string, carrierId: number, carrierRate: number): Promise<void> {
    try {
      // TODO: Call existing POST /api/loads/[id]/assign endpoint

      const response = await fetch(`${this.tmsApiUrl}/api/loads/${tmsLoadId}/assign`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `auth-token=${this.serviceToken}`,
        },
        body: JSON.stringify({
          carrier_id: carrierId,
          carrier_cost: carrierRate,
          auto_send_ratecon: true, // Send rate con PDF to carrier via email
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`TMS API error assigning carrier: ${JSON.stringify(error)}`);
      }

      logger.debug(`[Dispatcher] Assigned carrier ${carrierId} to TMS load ${tmsLoadId}`);
    } catch (error) {
      logger.error(`[Dispatcher] Failed to assign carrier to TMS load ${tmsLoadId}:`, error);

      // TODO: Implement fallback carrier assignment if first carrier fails
      // Try next carrier in stack from brief
      throw error;
    }
  }

  /**
   * Generate tracking token and send tracking link to shipper
   */
  private async sendTrackingLink(tmsLoadId: string, shipperEmail: string): Promise<void> {
    try {
      // TODO: Call existing POST /api/loads/[id]/tracking-token endpoint

      // Step 1: Generate token
      const tokenResponse = await fetch(`${this.tmsApiUrl}/api/loads/${tmsLoadId}/tracking-token`, {
        method: 'POST',
        headers: {
          Cookie: `auth-token=${this.serviceToken}`,
        },
      });

      if (!tokenResponse.ok) {
        logger.warn(`[Dispatcher] Failed to generate tracking token for load ${tmsLoadId}`);
        return; // Non-critical - continue
      }

      // Step 2: Send tracking link email
      const emailResponse = await fetch(`${this.tmsApiUrl}/api/loads/${tmsLoadId}/send-tracking`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `auth-token=${this.serviceToken}`,
        },
        body: JSON.stringify({ email: shipperEmail }),
      });

      if (!emailResponse.ok) {
        logger.warn(`[Dispatcher] Failed to send tracking link for load ${tmsLoadId}`);
        return; // Non-critical - continue
      }

      logger.debug(`[Dispatcher] Tracking link sent to ${shipperEmail} for TMS load ${tmsLoadId}`);
    } catch (error) {
      logger.error(`[Dispatcher] Error sending tracking link:`, error);
      // Non-critical - don't throw
    }
  }

  /**
   * Override updatePipelineLoad to store TMS linkage
   */
  protected async updatePipelineLoad(pipelineLoadId: number, result: any): Promise<void> {
    try {
      const { tmsLoadId } = result.details;

      await db.query(
        `UPDATE pipeline_loads
         SET stage = 'dispatched',
             stage_updated_at = NOW(),
             tms_load_id = $2,
             dispatched_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [pipelineLoadId, tmsLoadId]
      );

      logger.debug(
        `[Dispatcher] Pipeline load ${pipelineLoadId} linked to TMS load ${tmsLoadId} and advanced to 'dispatched'`
      );
    } catch (error) {
      logger.error(`[Dispatcher] Failed to update pipeline load ${pipelineLoadId}:`, error);
      throw error;
    }
  }
}

/**
 * Post-dispatch monitoring
 *
 * After dispatch, the load enters standard TMS operations:
 * - Check-calls every 4 hours (existing exception detection cron)
 * - GPS tracking via driver app
 * - POD capture on delivery
 * - Auto-invoice on POD (existing workflow trigger)
 *
 * When load is delivered, a cron job advances the pipeline:
 */
export async function advanceDeliveredLoads(): Promise<void> {
  try {
    // TODO: Run as cron job (e.g., every 30 minutes)
    // Check for loads marked as 'Delivered' in TMS

    await db.query(`
      UPDATE pipeline_loads
      SET stage = 'delivered',
          stage_updated_at = NOW(),
          delivered_at = NOW()
      WHERE tms_load_id IN (
        SELECT id FROM loads WHERE status = 'Delivered'
      )
      AND stage = 'dispatched'
    `);

    logger.debug('[Dispatcher] Delivery advancement cron completed');
  } catch (error) {
    logger.error('[Dispatcher] Error advancing delivered loads:', error);
  }
}

// TODO: Export initialized worker
// export const dispatcherWorker = new DispatcherWorker(redisClient, process.env.NEXT_PUBLIC_API_URL, serviceToken);
