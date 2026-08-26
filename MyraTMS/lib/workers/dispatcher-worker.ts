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
  // E2-03 M2 cascade outcome columns (migration 041) — read here so the
  // Dispatcher can consume a *secured* carrier instead of the Ranker's
  // pre-cascade top_carrier_id pick. See the "cascade-secured" branch below.
  carrier_call_outcome: string | null;
  carrier_id_secured: string | null;
  carrier_agreed_rate: string | null;
  carrier_agreed_currency: string | null;
  carrier_profit: string | null;
}

interface CreatedLoad {
  id: string;
}

interface CarrierRateResult {
  rate: number;
  estimated: boolean;
}

interface CarrierInfo {
  carrierStatus: string | null;
  phone: string | null;
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
      // nextStage MUST be set: BaseWorker.handleJob only calls
      // updatePipelineLoad when config.nextStage is truthy (base-worker.ts).
      // Our updatePipelineLoad() override writes the 'dispatched' stage
      // itself (hardcoded, alongside tms_load_id) — this value only exists
      // to satisfy that guard. Leaving it undefined silently skipped the
      // persist on the real queue-processing path: dispatch calls succeeded
      // against the TMS but pipeline_loads.tms_load_id was NEVER written,
      // which meant Task 3's idempotency guard (`load.tms_load_id ? reuse :
      // createTMSLoad()`) never actually triggered in production — the
      // duplicate-loads-row bug it was meant to close stayed open. This is
      // the identical bug already found and fixed for voice-worker.ts (see
      // its nextStage comment for the twin case). updatePipelineLoad()
      // still no-ops safely for the two escalation branches below — it
      // early-returns with a warning when result.details has no tmsLoadId,
      // which is true for both 'escalated' outcomes.
      nextStage: 'dispatched',
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
    // .trim().toLowerCase() so a trailing newline or stray casing on the
    // Vercel/Railway env value (a documented prior incident across all 4
    // kill-switch vars) can't silently defeat the exact-match check.
    this.carrierAutoAssignEnabled =
      opts.carrierAutoAssignEnabled ?? process.env.CARRIER_AUTO_ASSIGN_ENABLED?.trim().toLowerCase() === 'true';
  }

  public async process(payload: DispatchJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId, agreedRate, profit, callId } = payload;
    logger.debug(`[Dispatcher] Dispatching load ${pipelineLoadId}`);

    const load = await this.fetchPipelineLoad(pipelineLoadId);
    if (!load) throw new Error(`pipeline_load ${pipelineLoadId} not found`);

    // E2-03 M3 / PRD §11 (spec reconciliation, T-10 §4): once M2's cascade
    // has actually secured a real carrier (accept, within the negotiation
    // envelope), the Dispatcher consumes THAT carrier and rate instead of
    // the Ranker's pre-cascade top_carrier_id pick — the connective tissue
    // the PRD names but doesn't spell out as its own numbered task. This
    // branch is effectively inert today: nothing yet enqueues
    // carrier-call-queue automatically and CARRIER_CALLS_ENABLED stays
    // false, so carrier_call_outcome is never 'accept' in production yet —
    // it's wired now so it's ready the moment that changes, rather than
    // needing a follow-up session to notice the gate has nothing real to
    // gate against.
    const cascadeSecuredCarrierId =
      load.carrier_call_outcome === 'accept' ? load.carrier_id_secured : null;

    const carrierId = cascadeSecuredCarrierId ?? load.top_carrier_id;
    if (!carrierId) {
      throw new Error(`pipeline_load ${pipelineLoadId} has no top_carrier_id — cannot dispatch`);
    }

    // Prospect gate: the Ranker matches both 'prospect' and 'active' carriers
    // so shadow drains exercise the full pipeline, but real dispatch requires
    // 'active'. Carriers backfilled from FMCSA registries default to 'prospect'
    // and are promoted via PATCH /api/carriers/[id]/promote after human review.
    // Applies to a cascade-secured carrier exactly the same as top_carrier_id
    // — the cascade can secure an 'accept' from a prospect carrier just as
    // easily as an active one; the gate is a dispatch-time safety check, not
    // something the cascade itself enforces.
    const carrierInfo = await this.fetchCarrierStatus(carrierId);
    if (carrierInfo.carrierStatus !== 'active') {
      await this.escalateProspect(pipelineLoadId, carrierId, carrierInfo.carrierStatus, callId);
      return {
        success: true,
        pipelineLoadId,
        stage: 'escalated',
        duration: 0,
        details: {
          escalated: true,
          reason: 'top_carrier_not_active',
          carrierId,
          carrierStatus: carrierInfo.carrierStatus,
        },
      };
    }

    // E2-03 M0: no real carrier has agreed to run this load yet — Dispatch
    // One (E2-03 M2) is the module that will actually call carriers. Until
    // it's live, assigning here would tell the shipper a carrier is moving
    // their freight when no carrier has agreed to anything. A cascade-secured
    // carrier IS that real agreement, so it bypasses this gate entirely —
    // CARRIER_AUTO_ASSIGN_ENABLED only ever guarded the *blind* assign path
    // below, never a confirmed one.
    if (!cascadeSecuredCarrierId && !this.carrierAutoAssignEnabled) {
      await this.escalateCarrierConfirmation(
        pipelineLoadId,
        load,
        callId,
        agreedRate,
        payload.agreedRateCurrency,
        carrierInfo.phone,
      );
      return {
        success: true,
        pipelineLoadId,
        stage: 'escalated',
        duration: 0,
        details: {
          escalated: true,
          reason: 'carrier_auto_assign_disabled',
          carrierId,
        },
      };
    }

    // A cascade-secured rate is a real negotiated number, not an estimate —
    // fetchCarrierRate()'s match_results fallback (and its `estimated: true`
    // honesty flag) only applies to the blind-assign path below, which has
    // no real carrier rate to draw on at all.
    const carrierRateResult: CarrierRateResult = cascadeSecuredCarrierId
      ? { rate: Number(load.carrier_agreed_rate ?? 0), estimated: false }
      : await this.fetchCarrierRate(load.load_id, carrierId);

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
           carrier_cost_estimated = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [tmsLoad.id, pipelineLoadId, carrierRateResult.estimated],
    );

    // Step 3: assign the carrier. For a cascade-secured load, /assign's own
    // M3/M4 gate (lib/dispatch-gate.ts) is what actually flips status to
    // 'Dispatched' — it defers that flip until the carrier is verified and
    // a rate-con send has been attempted and logged.
    await this.assignCarrier(tmsLoad.id, carrierId, carrierRateResult.rate, cookie);

    // Step 4 + 5: tracking token + email link. Best-effort, non-fatal.
    if (load.shipper_email) {
      await this.sendTrackingLink(tmsLoad.id, load.shipper_email, cookie);
    } else {
      logger.debug(`[Dispatcher] No shipper email for load ${pipelineLoadId}; skipping tracking link`);
    }

    // The cascade's own envelope check already computed the real profit
    // (shipper rate minus the actual negotiated carrier rate) — use that
    // for a cascade-secured load rather than the shipper-acceptance-time
    // estimate the dispatch-queue payload carries, which predates any real
    // carrier contact.
    const effectiveProfit = cascadeSecuredCarrierId ? Number(load.carrier_profit ?? profit) : profit;

    logger.info(
      `[Dispatcher] Load ${pipelineLoadId} dispatched. tms_load_id=${tmsLoad.id}, carrier=${carrierId}` +
      (cascadeSecuredCarrierId ? ' (cascade-secured)' : '') +
      `, agreed=$${agreedRate}, profit=$${effectiveProfit}, call=${callId}`,
    );

    return {
      success: true,
      pipelineLoadId,
      stage: this.config.expectedStage,
      duration: 0,
      details: {
        tmsLoadId: tmsLoad.id,
        carrierId,
        carrierRate: carrierRateResult.rate,
        agreedRate,
        profit: effectiveProfit,
        cascadeSecured: cascadeSecuredCarrierId != null,
      },
    };
  }

  private async fetchPipelineLoad(id: number): Promise<PipelineLoadRow | null> {
    const r = await db.query<PipelineLoadRow>(
      `SELECT id, load_id, origin_city, origin_state, destination_city, destination_state,
              pickup_date, delivery_date, equipment_type, commodity, weight_lbs,
              shipper_company, shipper_email, shipper_phone, top_carrier_id, tms_load_id,
              carrier_call_outcome, carrier_id_secured, carrier_agreed_rate,
              carrier_agreed_currency, carrier_profit
       FROM pipeline_loads WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  private async fetchCarrierStatus(carrierId: string): Promise<CarrierInfo> {
    const r = await db.query<{ carrier_status: string | null; contact_phone: string | null }>(
      `SELECT carrier_status, contact_phone FROM carriers WHERE id = $1`,
      [carrierId],
    );
    const row = r.rows[0];
    return { carrierStatus: row?.carrier_status ?? null, phone: row?.contact_phone ?? null };
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
    agreedRate: number,
    agreedRateCurrency: string,
    carrierPhone: string | null,
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
      (carrierPhone ? `Carrier phone: ${carrierPhone}. ` : '') +
      `Pickup ${pickup}, equipment ${load.equipment_type}` +
      (load.weight_lbs ? `, ${load.weight_lbs} lbs` : '') +
      (load.shipper_company ? `. Shipper: ${load.shipper_company}` : '') +
      `. Agreed rate: $${agreedRate} ${agreedRateCurrency}.`;
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

  private async fetchCarrierRate(loadId: string, carrierId: string): Promise<CarrierRateResult> {
    const r = await db.query<{ breakdown: any }>(
      `SELECT breakdown FROM match_results
       WHERE load_id = $1 AND carrier_id = $2
       ORDER BY match_score DESC LIMIT 1`,
      [loadId, carrierId],
    );
    const carrierAvg = r.rows[0]?.breakdown?.rate?.carrier_avg_rate;
    if (typeof carrierAvg === 'number' && carrierAvg > 0) {
      return { rate: carrierAvg, estimated: false };
    }
    // E2-02 §4 item 3: no real rate history for this carrier. Returning 0
    // silently made margin = revenue (100% margin), indistinguishable from a
    // genuine zero-cost load. `estimated: true` is the honesty flag — it
    // doesn't fix the underlying "no real carrier rate" problem (M2 does
    // that by actually negotiating one), it stops the number from lying
    // about its own confidence in the interim.
    return { rate: 0, estimated: true };
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
