/**
 * AGENT 7 - DISPATCHER WORKER
 *
 * Handles everything after a load is booked. Bridges Engine 2 (AI pipeline)
 * with Engine 1 (TMS operations) by chaining the existing TMS API routes:
 *
 *   POST /api/loads                          → creates the load row
 *   UPDATE loads (direct DB)                 → patches pipeline linkage cols
 *   POST /api/loads/[id]/assign              → attaches carrier
 *   POST /api/loads/[id]/tracking-token      → generates tracking token
 *   POST /api/loads/[id]/send-tracking       → emails the link to shipper
 *
 * Auth: short-lived JWT minted via signServiceToken() — same payload shape as
 * a real user JWT (userId='system', role='admin'), so it sails through the
 * Edge middleware verifier and resolves via getCurrentUser() in the route
 * handlers without route-side changes.
 *
 * Input:  dispatch-queue with DispatchJobPayload (enqueued by the webhook
 *         when a call books with auto_book_eligible=true)
 * Output: TMS load row created, carrier assigned, tracking link sent;
 *         pipeline_loads.tms_load_id populated, stage advanced to 'dispatched'.
 */

import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import Redis from 'ioredis';
import { signServiceToken } from '@/lib/pipeline/service-token';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

/**
 * Dispatch payload — matches the shape the webhook's `enqueueNextAction()`
 * produces. The Dispatcher fetches everything else (carrier id, shipper
 * email, equipment, etc.) from the DB so the queue payload stays minimal.
 */
export interface DispatchJobPayload extends BaseJobPayload {
  agreedRate: number;
  agreedRateCurrency: string;
  profit: number;
  callId: string;
}

interface PipelineLoadRow {
  id: number;
  load_id: string;
  origin_city: string;
  origin_state: string;
  destination_city: string;
  destination_state: string;
  pickup_date: Date | null;
  delivery_date: Date | null;
  equipment_type: string;
  commodity: string | null;
  weight_lbs: number | null;
  shipper_company: string | null;
  shipper_email: string | null;
  shipper_phone: string | null;
  top_carrier_id: string | null;
  tms_load_id: string | null;
}

interface CreatedLoad {
  id: string;
}

export class DispatcherWorker extends BaseWorker<DispatchJobPayload> {
  private tmsApiUrl: string;
  private serviceTokenTtl: string;
  private carrierAutoAssignEnabled: boolean;

  constructor(
    redis: Redis,
    opts: { tmsApiUrl?: string; serviceTokenTtl?: string; carrierAutoAssignEnabled?: boolean } = {},
  ) {
    const config: WorkerConfig = {
      queueName: 'dispatch-queue',
      expectedStage: 'booked',
      // nextStage handled inside updatePipelineLoad — we also need to write
      // tms_load_id alongside the stage transition.
      nextStage: undefined,
      concurrency: 10,
      retryConfig: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
      },
      redis,
    };
    super(config);

    this.tmsApiUrl =
      opts.tmsApiUrl ?? process.env.TMS_API_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
    this.serviceTokenTtl = opts.serviceTokenTtl ?? '5m';
    // E2-03 M0: default OFF — the always-on auto-assign is the dangerous
    // state (fabricates a carrier commitment that was never obtained), not
    // the guarded one. Flip only after M2's real carrier-calling cascade is
    // live and validated end to end.
    this.carrierAutoAssignEnabled = opts.carrierAutoAssignEnabled ?? process.env.CARRIER_AUTO_ASSIGN_ENABLED === 'true';
  }

  public async process(payload: DispatchJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId, agreedRate, profit, callId } = payload;
    logger.debug(`[Dispatcher] Dispatching load ${pipelineLoadId}`);

    const load = await this.fetchPipelineLoad(pipelineLoadId);
    if (!load) throw new Error(`pipeline_load ${pipelineLoadId} not found`);
    if (!load.top_carrier_id) {
      throw new Error(`pipeline_load ${pipelineLoadId} has no top_carrier_id — cannot dispatch`);
    }

    // Prospect gate: the Ranker matches both 'prospect' and 'active' carriers
    // so shadow drains exercise the full pipeline, but real dispatch requires
    // 'active'. Carriers backfilled from FMCSA registries default to 'prospect'
    // and are promoted via PATCH /api/carriers/[id]/promote after human review.
    const carrierStatus = await this.fetchCarrierStatus(load.top_carrier_id);
    if (carrierStatus !== 'active') {
      await this.escalateProspect(pipelineLoadId, load.top_carrier_id, carrierStatus, callId);
      return {
        success: true,
        pipelineLoadId,
        stage: 'escalated',
        duration: 0,
        details: {
          escalated: true,
          reason: 'top_carrier_not_active',
          carrierId: load.top_carrier_id,
          carrierStatus,
        },
      };
    }

    // E2-03 M0: no real carrier has agreed to run this load yet — Dispatch
    // One (E2-03 M2) is the module that will actually call carriers. Until
    // it's live, assigning here would tell the shipper a carrier is moving
    // their freight when no carrier has agreed to anything.
    if (!this.carrierAutoAssignEnabled) {
      await this.escalateCarrierConfirmation(pipelineLoadId, load, callId);
      return {
        success: true,
        pipelineLoadId,
        stage: 'escalated',
        duration: 0,
        details: {
          escalated: true,
          reason: 'carrier_auto_assign_disabled',
          carrierId: load.top_carrier_id,
        },
      };
    }

    const carrierRate = await this.fetchCarrierRate(load.load_id, load.top_carrier_id);

    const cookie = `auth-token=${signServiceToken(this.serviceTokenTtl)}`;

    // Step 1: create the TMS load row — or reuse one from a prior attempt.
    // E2-02 §4 item 2: a dispatch-queue retry after a downstream failure
    // (e.g. assignCarrier throws) used to re-run from the top and create a
    // second loads row for the same pipeline_loads entry. tms_load_id is
    // the natural idempotency key — once set, it's never re-created.
    const tmsLoad = load.tms_load_id
      ? { id: load.tms_load_id }
      : await this.createTMSLoad(load, agreedRate, payload.agreedRateCurrency, cookie);

    // Step 2: patch the pipeline-linkage columns the route doesn't handle.
    await db.query(
      `UPDATE loads
       SET pipeline_load_id = $2,
           source_type = 'ai_agent',
           booked_via = 'ai_auto',
           updated_at = NOW()
       WHERE id = $1`,
      [tmsLoad.id, pipelineLoadId],
    );

    // Step 3: assign the carrier (also flips loads.status to 'Dispatched').
    await this.assignCarrier(tmsLoad.id, load.top_carrier_id, carrierRate, cookie);

    // Step 4 + 5: tracking token + email link. Best-effort, non-fatal.
    if (load.shipper_email) {
      await this.sendTrackingLink(tmsLoad.id, load.shipper_email, cookie);
    } else {
      logger.debug(`[Dispatcher] No shipper email for load ${pipelineLoadId}; skipping tracking link`);
    }

    logger.info(
      `[Dispatcher] Load ${pipelineLoadId} dispatched. tms_load_id=${tmsLoad.id}, carrier=${load.top_carrier_id}, agreed=$${agreedRate}, profit=$${profit}, call=${callId}`,
    );

    return {
      success: true,
      pipelineLoadId,
      stage: this.config.expectedStage,
      duration: 0,
      details: {
        tmsLoadId: tmsLoad.id,
        carrierId: load.top_carrier_id,
        carrierRate,
        agreedRate,
        profit,
      },
    };
  }

  private async fetchPipelineLoad(id: number): Promise<PipelineLoadRow | null> {
    const r = await db.query<PipelineLoadRow>(
      `SELECT id, load_id, origin_city, origin_state, destination_city, destination_state,
              pickup_date, delivery_date, equipment_type, commodity, weight_lbs,
              shipper_company, shipper_email, shipper_phone, top_carrier_id, tms_load_id
       FROM pipeline_loads WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  private async fetchCarrierStatus(carrierId: string): Promise<string | null> {
    const r = await db.query<{ carrier_status: string }>(
      `SELECT carrier_status FROM carriers WHERE id = $1`,
      [carrierId],
    );
    return r.rows[0]?.carrier_status ?? null;
  }

  private async escalateProspect(
    pipelineLoadId: number,
    carrierId: string,
    carrierStatus: string | null,
    callId: string,
  ): Promise<void> {
    await db.query(
      `UPDATE pipeline_loads
       SET stage = 'escalated', stage_updated_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [pipelineLoadId],
    );
    logger.warn(
      `[Dispatcher] Load ${pipelineLoadId} escalated: top carrier ${carrierId} has carrier_status='${carrierStatus ?? 'unknown'}' (must be 'active' to dispatch); call=${callId}`,
    );
  }

  private async escalateCarrierConfirmation(
    pipelineLoadId: number,
    load: PipelineLoadRow,
    callId: string,
  ): Promise<void> {
    await db.query(
      `UPDATE pipeline_loads
       SET stage = 'escalated', stage_updated_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [pipelineLoadId],
    );

    const title = `Carrier confirmation needed: ${load.origin_city}, ${load.origin_state} → ${load.destination_city}, ${load.destination_state}`;
    const pickup = load.pickup_date ? this.toIsoDate(load.pickup_date) : 'unknown';
    const detail =
      `AI carrier calling is not yet live. Secure carrier ${load.top_carrier_id} for this load by phone. ` +
      `Pickup ${pickup}, equipment ${load.equipment_type}` +
      (load.weight_lbs ? `, ${load.weight_lbs} lbs` : '') +
      (load.shipper_company ? `. Shipper: ${load.shipper_company}` : '') +
      `.`;
    const suggestedAction = 'Secure a carrier for this load by phone. AI carrier calling is not yet live.';

    await db.query(
      `INSERT INTO exceptions (
         load_id, carrier_id, type, severity, title, detail,
         pipeline_load_id, source_module, suggested_action, sla_due_at
       ) VALUES (
         NULL, $1, 'carrier_confirmation_required', 'high', $2, $3,
         $4, 'carrier_confirmation_required', $5, NOW() + INTERVAL '4 hours'
       )`,
      [load.top_carrier_id, title, detail, pipelineLoadId, suggestedAction],
    );

    logger.warn(
      `[Dispatcher] Load ${pipelineLoadId} escalated: CARRIER_AUTO_ASSIGN_ENABLED=false, carrier ${load.top_carrier_id} not yet confirmed; call=${callId}`,
    );
  }

  private async fetchCarrierRate(loadId: string, carrierId: string): Promise<number> {
    const r = await db.query<{ breakdown: any }>(
      `SELECT breakdown FROM match_results
       WHERE load_id = $1 AND carrier_id = $2
       ORDER BY match_score DESC LIMIT 1`,
      [loadId, carrierId],
    );
    const carrierAvg = r.rows[0]?.breakdown?.rate?.carrier_avg_rate;
    return typeof carrierAvg === 'number' && carrierAvg > 0 ? carrierAvg : 0;
  }

  private async createTMSLoad(
    load: PipelineLoadRow,
    agreedRate: number,
    currency: string,
    cookie: string,
  ): Promise<CreatedLoad> {
    const body = {
      origin: `${load.origin_city}, ${load.origin_state}`,
      destination: `${load.destination_city}, ${load.destination_state}`,
      revenue: agreedRate,
      carrierCost: 0,
      equipment: load.equipment_type,
      weight: load.weight_lbs?.toString() ?? '',
      pickupDate: load.pickup_date ? this.toIsoDate(load.pickup_date) : null,
      deliveryDate: load.delivery_date ? this.toIsoDate(load.delivery_date) : null,
      // loads.source has a CHECK constraint allowing only
      // 'Load Board' | 'Contract Shipper' | 'One-off Shipper'. Engine 2's
      // loads are board-sourced (DAT, Truckstop, etc.) so 'Load Board' is
      // the correct value. The booked_via='ai_auto' linkage column we set
      // below distinguishes AI dispatches from human-booked ones.
      source: 'Load Board',
      status: 'Booked',
      shipperName: load.shipper_company ?? '',
    };

    const res = await fetch(`${this.tmsApiUrl}/api/loads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '<unparseable>');
      throw new Error(`POST /api/loads ${res.status}: ${text}`);
    }
    const created = (await res.json()) as { id: string };
    if (!created.id) throw new Error(`POST /api/loads returned no id: ${JSON.stringify(created)}`);
    return { id: created.id };
  }

  private async assignCarrier(
    tmsLoadId: string,
    carrierId: string,
    carrierRate: number,
    cookie: string,
  ): Promise<void> {
    const res = await fetch(`${this.tmsApiUrl}/api/loads/${tmsLoadId}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        carrier_id: carrierId,
        carrier_rate: carrierRate,
        assignment_method: 'ai_auto',
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '<unparseable>');
      throw new Error(`POST /api/loads/${tmsLoadId}/assign ${res.status}: ${text}`);
    }
  }

  private async sendTrackingLink(tmsLoadId: string, email: string, cookie: string): Promise<void> {
    const tokRes = await fetch(`${this.tmsApiUrl}/api/loads/${tmsLoadId}/tracking-token`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    if (!tokRes.ok) {
      logger.warn(`[Dispatcher] tracking-token returned ${tokRes.status} for ${tmsLoadId}; skipping email`);
      return;
    }
    const sendRes = await fetch(`${this.tmsApiUrl}/api/loads/${tmsLoadId}/send-tracking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ email }),
    });
    if (!sendRes.ok) {
      logger.warn(`[Dispatcher] send-tracking returned ${sendRes.status} for ${tmsLoadId}`);
    }
  }

  private toIsoDate(d: Date | string): string {
    return (d instanceof Date ? d : new Date(d)).toISOString().split('T')[0];
  }

  protected async updatePipelineLoad(pipelineLoadId: number, result: ProcessResult): Promise<void> {
    const tmsLoadId = result.details?.tmsLoadId as string | undefined;
    if (!tmsLoadId) {
      logger.warn(`[Dispatcher] No tmsLoadId in result for load ${pipelineLoadId}; not advancing stage`);
      return;
    }
    await db.query(
      `UPDATE pipeline_loads
       SET stage = 'dispatched',
           stage_updated_at = NOW(),
           tms_load_id = $2,
           dispatched_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [pipelineLoadId, tmsLoadId],
    );
    logger.debug(`[Dispatcher] Load ${pipelineLoadId} → 'dispatched'; tms_load_id=${tmsLoadId}`);
  }
}

/**
 * Cron-callable: advance pipeline_loads to 'delivered' when their linked
 * loads.status flips to 'Delivered'. Idempotent — only flips loads currently
 * in 'dispatched'. Driven by /api/cron/pipeline-health.
 */
export async function advanceDeliveredLoads(): Promise<{ advanced: number }> {
  const r = await db.query<{ id: number }>(
    `UPDATE pipeline_loads pl
     SET stage = 'delivered',
         stage_updated_at = NOW(),
         delivered_at = NOW()
     FROM loads l
     WHERE pl.tms_load_id = l.id
       AND l.status = 'Delivered'
       AND pl.stage = 'dispatched'
     RETURNING pl.id`,
  );
  if (r.rows.length > 0) {
    logger.info(`[Dispatcher] Advanced ${r.rows.length} loads to 'delivered'`);
  }
  return { advanced: r.rows.length };
}
