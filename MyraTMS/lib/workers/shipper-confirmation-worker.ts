/**
 * E2-04 M2 — SHIPPER WRITTEN-CONFIRMATION WORKER
 *
 * The trigger PRD's first new agent. A shipper call booking ('booked' stage,
 * auto_book_eligible) used to enqueue dispatch-queue directly — this worker
 * now sits between the two: no carrier is ever contacted until the shipper
 * has confirmed the load IN WRITING. retell-webhook.ts's enqueueNextAction()
 * enqueues this queue's 'send' job instead of dispatch-queue on booking; the
 * carrier-side brief compiler (M5) is what eventually re-triggers
 * dispatch-queue, once a carrier is secured.
 *
 * One queue, three self-scheduled job types via `action`, same pattern
 * carrier-call-queue already uses for its voicemail retry:
 *
 *   'send'     — fires immediately on 'booked'. Generates a confirmation
 *                token + immutable snapshot of the agreed terms, generates
 *                the shipper-side rate-con PDF, emails it with a confirm
 *                link, advances stage to 'awaiting_shipper_confirmation',
 *                then self-schedules 'nudge' (+45min) and 'escalate' (+2h).
 *   'nudge'    — resends a shorter reminder if the shipper hasn't acted yet.
 *                No-ops if already confirmed/escalated, or already nudged.
 *   'escalate' — if still unconfirmed after 2h, stage → 'escalated' with an
 *                exceptions row for human follow-up. No-ops if confirmed.
 *
 * All three read+write pipeline_loads directly rather than going through
 * BaseWorker's single-expectedStage nextStage hook (base-worker.ts:122),
 * because the three actions expect three different stages — same reasoning
 * carrier-voice-worker.ts documents for its own multi-state cascade.
 *
 * Kill switches:
 *   PIPELINE_ENABLED=false             skips every job (whole-pipeline halt,
 *                                       matches every other worker).
 *   SHIPPER_CONFIRMATION_ENABLED       E2-04 review session, F2 (closes V2).
 *                                       Defaults FALSE -- outbound SMTP is
 *                                       not configured anywhere in production
 *                                       today (confirmed via `vercel env ls`),
 *                                       so this worker cannot succeed regardless.
 *                                       Before this flag existed, 'send' ran
 *                                       unconditionally, the email send's
 *                                       success/failure was never checked, and
 *                                       a load silently sat in
 *                                       'awaiting_shipper_confirmation' for the
 *                                       full 2h nudge/escalate SLA before a
 *                                       human ever saw it -- a real regression
 *                                       against E2-03 M0's immediate-hold
 *                                       principle. When this flag is off, or
 *                                       when the send genuinely fails, 'send'
 *                                       now escalates to Alert Center
 *                                       immediately instead of scheduling the
 *                                       nudge/escalate SLA at all -- that SLA
 *                                       is for shipper inaction, not for
 *                                       infrastructure that doesn't exist yet.
 */

import { Queue } from 'bullmq';
import Redis from 'ioredis';
import crypto from 'crypto';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { generateShipperRateConfirmation } from '@/lib/shipper-rate-confirmation';
import { sendShipperConfirmationRequestEmail } from '@/lib/email';
import { BaseWorker, BaseJobPayload, ProcessResult, WorkerConfig } from './base-worker';

export interface ShipperConfirmationJobPayload extends BaseJobPayload {
  action: 'send' | 'nudge' | 'escalate';
}

const NUDGE_DELAY_MS = 45 * 60 * 1000; // 45 minutes
const ESCALATE_DELAY_MS = 2 * 60 * 60 * 1000; // 2 hours
const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface PipelineLoadRow {
  id: number;
  load_id: string;
  stage: string;
  origin_city: string;
  origin_state: string;
  destination_city: string;
  destination_state: string;
  pickup_date: string | null;
  delivery_date: string | null;
  equipment_type: string;
  shipper_company: string | null;
  shipper_contact_name: string | null;
  shipper_email: string | null;
  agreed_rate: string | null;
  agreed_rate_currency: string | null;
  confirmation_nudged_at: string | null;
}

export class ShipperConfirmationWorker extends BaseWorker<ShipperConfirmationJobPayload> {
  private selfQueue: Queue<ShipperConfirmationJobPayload>;
  private trackingBaseUrl: string;
  private shipperConfirmationEnabled: boolean;

  constructor(
    redis: Redis,
    selfQueue: Queue<ShipperConfirmationJobPayload>,
    opts: { trackingBaseUrl?: string; shipperConfirmationEnabled?: boolean } = {},
  ) {
    const config: WorkerConfig = {
      queueName: 'shipper-confirmation-queue',
      expectedStage: 'booked', // only meaningful for the 'send' action; see validateLoad() override
      // nextStage left undefined deliberately: each action writes its own
      // stage transition directly (or none, for a no-op skip) rather than
      // going through BaseWorker's single-nextStage hook, which can't
      // express three different target stages for one queue.
      nextStage: undefined,
      concurrency: 10,
      retryConfig: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30000 },
      },
      redis,
    };
    super(config);

    this.selfQueue = selfQueue;
    this.trackingBaseUrl =
      opts.trackingBaseUrl ?? process.env.NEXT_PUBLIC_TRACKING_URL ?? 'http://localhost:3002';
    // Defaults false -- see file header. .trim().toLowerCase() so a stray
    // trailing newline/casing on the Vercel env value (a documented prior
    // incident across every other kill switch in this codebase) can't
    // silently defeat the exact-match check.
    this.shipperConfirmationEnabled =
      opts.shipperConfirmationEnabled ?? process.env.SHIPPER_CONFIRMATION_ENABLED?.trim().toLowerCase() === 'true';
  }

  // Overridden: the base class's validateLoad() gates on a single
  // this.config.expectedStage, but 'send' expects 'booked' while 'nudge'/
  // 'escalate' expect 'awaiting_shipper_confirmation'. Fetch unconditionally
  // here; process() below checks the stage that's correct for its action and
  // no-ops cleanly on a mismatch (e.g. a nudge firing after the shipper
  // already confirmed) rather than the base class silently dropping the job.
  protected async validateLoad(pipelineLoadId: number): Promise<PipelineLoadRow | null> {
    const r = await db.query<PipelineLoadRow>(
      `SELECT id, load_id, stage, origin_city, origin_state, destination_city, destination_state,
              pickup_date, delivery_date, equipment_type,
              shipper_company, shipper_contact_name, shipper_email,
              agreed_rate, agreed_rate_currency, confirmation_nudged_at
         FROM pipeline_loads WHERE id = $1`,
      [pipelineLoadId],
    );
    return r.rows[0] ?? null;
  }

  public async process(payload: ShipperConfirmationJobPayload): Promise<ProcessResult> {
    const { pipelineLoadId } = payload;

    if (process.env.PIPELINE_ENABLED !== 'true') {
      logger.info(`[ShipperConfirmation] PIPELINE_ENABLED=false — skipping load ${pipelineLoadId}`);
      return { success: true, pipelineLoadId, stage: 'booked', duration: 0, details: { skipped: 'pipeline_disabled' } };
    }

    const load = await this.validateLoad(pipelineLoadId);
    if (!load) {
      logger.warn(`[ShipperConfirmation] Load ${pipelineLoadId} not found`);
      return { success: true, pipelineLoadId, stage: 'unknown', duration: 0, details: { skipped: 'not_found' } };
    }

    switch (payload.action) {
      case 'send':
        return this.handleSend(load);
      case 'nudge':
        return this.handleNudge(load);
      case 'escalate':
        return this.handleEscalate(load);
      default:
        return { success: true, pipelineLoadId, stage: load.stage, duration: 0, details: { skipped: 'unknown_action' } };
    }
  }

  private async handleSend(load: PipelineLoadRow): Promise<ProcessResult> {
    if (load.stage !== 'booked') {
      logger.debug(`[ShipperConfirmation] Load ${load.id} not at 'booked' (is '${load.stage}') — skipping send`);
      return { success: true, pipelineLoadId: load.id, stage: load.stage, duration: 0, details: { skipped: 'stage_mismatch' } };
    }

    // F2 (closes V2): checked before anything else -- if the feature is off,
    // nothing downstream (email validity, PDF generation) matters. Straight
    // to Alert Center rather than silently doing nothing.
    if (!this.shipperConfirmationEnabled) {
      await this.escalateConfirmationDisabled(load);
      return { success: true, pipelineLoadId: load.id, stage: 'escalated', duration: 0, details: { escalated: true, reason: 'shipper_confirmation_disabled' } };
    }

    if (!load.shipper_email) {
      await this.escalateMissingEmail(load);
      return { success: true, pipelineLoadId: load.id, stage: 'escalated', duration: 0, details: { escalated: true, reason: 'no_shipper_email' } };
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);

    // Immutable snapshot of exactly what the shipper is being asked to
    // confirm — later mutation of pipeline_loads (e.g. a stale re-run) can't
    // silently change the terms displayed on the confirm page.
    const snapshot = {
      loadId: load.load_id,
      origin: `${load.origin_city}, ${load.origin_state}`,
      destination: `${load.destination_city}, ${load.destination_state}`,
      pickupDate: load.pickup_date,
      deliveryDate: load.delivery_date,
      equipmentType: load.equipment_type,
      rate: load.agreed_rate,
      rateCurrency: load.agreed_rate_currency,
      snapshotAt: new Date().toISOString(),
    };

    // F2 (closes V2): PDF generation and the email send are wrapped here,
    // deliberately NOT allowed to propagate to BaseWorker's outer try/catch
    // (base-worker.ts's handleJob) -- that path retries 3x with exponential
    // backoff before dead-lettering, which is the right shape for a
    // transient infrastructure blip but the wrong shape for "SMTP isn't
    // configured at all," which will never succeed on retry. Escalate on the
    // FIRST hard failure instead of burning the retry budget or (previously)
    // silently proceeding as if nothing was wrong. sendShipperConfirmation
    // RequestEmail() returning false (SMTP unconfigured) is exactly as much
    // a hard failure here as it throwing -- both used to be treated as
    // success.
    let pdfBuffer: Buffer;
    let sent: boolean;
    try {
      pdfBuffer = await generateShipperRateConfirmation(load.id);
      const confirmUrl = `${this.trackingBaseUrl}/track/${token}`;
      sent = await sendShipperConfirmationRequestEmail(
        load.shipper_email,
        load.shipper_contact_name,
        load.load_id,
        confirmUrl,
        pdfBuffer,
      );
    } catch (err) {
      await this.escalateSendFailed(load, err instanceof Error ? err.message : String(err));
      return { success: true, pipelineLoadId: load.id, stage: 'escalated', duration: 0, details: { escalated: true, reason: 'shipper_confirmation_send_failed' } };
    }
    if (!sent) {
      await this.escalateSendFailed(load, 'sendShipperConfirmationRequestEmail returned false (SMTP unconfigured or send failed)');
      return { success: true, pipelineLoadId: load.id, stage: 'escalated', duration: 0, details: { escalated: true, reason: 'shipper_confirmation_send_failed' } };
    }

    await db.query(
      `UPDATE pipeline_loads
       SET confirmation_token = $2,
           confirmation_token_expires_at = $3,
           confirmation_sent_at = NOW(),
           confirmation_snapshot = $4,
           stage = 'awaiting_shipper_confirmation',
           stage_updated_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [load.id, token, expiresAt.toISOString(), JSON.stringify(snapshot)],
    );

    await this.selfQueue.add(
      'nudge',
      { pipelineLoadId: load.id, loadId: load.load_id, loadBoardSource: '', enqueuedAt: new Date().toISOString(), priority: 0, action: 'nudge' },
      { delay: NUDGE_DELAY_MS },
    );
    await this.selfQueue.add(
      'escalate',
      { pipelineLoadId: load.id, loadId: load.load_id, loadBoardSource: '', enqueuedAt: new Date().toISOString(), priority: 0, action: 'escalate' },
      { delay: ESCALATE_DELAY_MS },
    );

    logger.info(
      `[ShipperConfirmation] Load ${load.id} confirmation request sent, token issued, advanced to 'awaiting_shipper_confirmation'`,
    );

    return {
      success: true,
      pipelineLoadId: load.id,
      stage: 'awaiting_shipper_confirmation',
      duration: 0,
      details: { emailSent: true, tokenIssued: true },
    };
  }

  private async handleNudge(load: PipelineLoadRow): Promise<ProcessResult> {
    if (load.stage !== 'awaiting_shipper_confirmation') {
      logger.debug(`[ShipperConfirmation] Load ${load.id} no longer awaiting confirmation (is '${load.stage}') — skipping nudge`);
      return { success: true, pipelineLoadId: load.id, stage: load.stage, duration: 0, details: { skipped: 'already_resolved' } };
    }
    if (load.confirmation_nudged_at) {
      return { success: true, pipelineLoadId: load.id, stage: load.stage, duration: 0, details: { skipped: 'already_nudged' } };
    }
    if (!load.shipper_email) {
      return { success: true, pipelineLoadId: load.id, stage: load.stage, duration: 0, details: { skipped: 'no_shipper_email' } };
    }

    const row = await db.query<{ confirmation_token: string | null }>(
      `SELECT confirmation_token FROM pipeline_loads WHERE id = $1`,
      [load.id],
    );
    const token = row.rows[0]?.confirmation_token;
    if (!token) {
      return { success: true, pipelineLoadId: load.id, stage: load.stage, duration: 0, details: { skipped: 'no_token' } };
    }

    const pdfBuffer = await generateShipperRateConfirmation(load.id);
    const confirmUrl = `${this.trackingBaseUrl}/track/${token}`;
    const sent = await sendShipperConfirmationRequestEmail(
      load.shipper_email,
      load.shipper_contact_name,
      load.load_id,
      confirmUrl,
      pdfBuffer,
      { nudge: true },
    );

    await db.query(
      `UPDATE pipeline_loads SET confirmation_nudged_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [load.id],
    );

    logger.info(`[ShipperConfirmation] Load ${load.id} nudge sent=${sent}`);

    return { success: true, pipelineLoadId: load.id, stage: load.stage, duration: 0, details: { nudgeSent: sent } };
  }

  private async handleEscalate(load: PipelineLoadRow): Promise<ProcessResult> {
    if (load.stage !== 'awaiting_shipper_confirmation') {
      logger.debug(`[ShipperConfirmation] Load ${load.id} already resolved (is '${load.stage}') — skipping escalation`);
      return { success: true, pipelineLoadId: load.id, stage: load.stage, duration: 0, details: { skipped: 'already_resolved' } };
    }

    await db.query(
      `UPDATE pipeline_loads
       SET stage = 'escalated', stage_updated_at = NOW(), confirmation_outcome = 'timeout', updated_at = NOW()
       WHERE id = $1`,
      [load.id],
    );

    const title = `Shipper confirmation timed out: ${load.origin_city}, ${load.origin_state} → ${load.destination_city}, ${load.destination_state}`;
    const detail =
      `Load ${load.load_id} was booked and a written-confirmation request was sent, but no response ` +
      `(click or reply) arrived within 2 hours. Follow up with the shipper directly at ` +
      `${load.shipper_email || 'no email on file'} before this load ages further.`;

    await db.query(
      `INSERT INTO exceptions (
         load_id, carrier_id, type, severity, title, detail,
         pipeline_load_id, source_module, suggested_action, sla_due_at
       ) VALUES (
         NULL, NULL, 'shipper_confirmation_timeout', 'high', $1, $2,
         $3, 'shipper_confirmation_timeout', $4, NOW() + INTERVAL '2 hours'
       )`,
      [title, detail, load.id, 'Contact the shipper by phone to confirm the load in writing.'],
    );

    logger.warn(`[ShipperConfirmation] Load ${load.id} escalated: confirmation timeout after 2h`);

    return { success: true, pipelineLoadId: load.id, stage: 'escalated', duration: 0, details: { escalated: true, reason: 'confirmation_timeout' } };
  }

  private async escalateMissingEmail(load: PipelineLoadRow): Promise<void> {
    await db.query(
      `UPDATE pipeline_loads
       SET stage = 'escalated', stage_updated_at = NOW(), confirmation_outcome = 'no_email', updated_at = NOW()
       WHERE id = $1`,
      [load.id],
    );

    const title = `No shipper email on file: ${load.origin_city}, ${load.origin_state} → ${load.destination_city}, ${load.destination_state}`;
    const detail =
      `Load ${load.load_id} booked but the call parser did not capture a shipper email, so no written ` +
      `confirmation request could be sent. Contact the shipper directly to collect an email or a verbal confirmation.`;

    await db.query(
      `INSERT INTO exceptions (
         load_id, carrier_id, type, severity, title, detail,
         pipeline_load_id, source_module, suggested_action, sla_due_at
       ) VALUES (
         NULL, NULL, 'shipper_confirmation_no_email', 'high', $1, $2,
         $3, 'shipper_confirmation_no_email', $4, NOW() + INTERVAL '1 hour'
       )`,
      [title, detail, load.id, 'Call the shipper back to collect an email address, or confirm verbally and record it.'],
    );

    logger.warn(`[ShipperConfirmation] Load ${load.id} escalated: no shipper_email captured on the booking call`);
  }

  // F2 (closes V2): the feature is off (SHIPPER_CONFIRMATION_ENABLED=false --
  // defaults false today, since outbound SMTP isn't configured in production).
  private async escalateConfirmationDisabled(load: PipelineLoadRow): Promise<void> {
    await db.query(
      `UPDATE pipeline_loads
       SET stage = 'escalated', stage_updated_at = NOW(), confirmation_outcome = 'disabled', updated_at = NOW()
       WHERE id = $1`,
      [load.id],
    );

    const title = `Shipper confirmation disabled: ${load.origin_city}, ${load.origin_state} → ${load.destination_city}, ${load.destination_state}`;
    const detail =
      `Load ${load.load_id} booked, but SHIPPER_CONFIRMATION_ENABLED is off -- no confirmation request was ` +
      `attempted. Confirm the load with the shipper directly (phone or manual email) and record the confirmation.`;

    await db.query(
      `INSERT INTO exceptions (
         load_id, carrier_id, type, severity, title, detail,
         pipeline_load_id, source_module, suggested_action, sla_due_at
       ) VALUES (
         NULL, NULL, 'shipper_confirmation_disabled', 'high', $1, $2,
         $3, 'shipper_confirmation_disabled', $4, NOW() + INTERVAL '1 hour'
       )`,
      [title, detail, load.id, 'Contact the shipper directly to confirm the load in writing, then record it via the ops override.'],
    );

    logger.warn(`[ShipperConfirmation] Load ${load.id} escalated: SHIPPER_CONFIRMATION_ENABLED=false`);
  }

  // F2 (closes V2): the send genuinely failed (SMTP unreachable, unconfigured,
  // or sendShipperConfirmationRequestEmail() returned false) -- escalate on
  // this first hard failure rather than silently proceeding as if it
  // succeeded (the previous behavior: the `sent` boolean was captured and
  // never checked) or waiting out the full 2h nudge/escalate SLA, which is
  // for shipper inaction, not for infrastructure that doesn't exist.
  private async escalateSendFailed(load: PipelineLoadRow, reason: string): Promise<void> {
    await db.query(
      `UPDATE pipeline_loads
       SET stage = 'escalated', stage_updated_at = NOW(), confirmation_outcome = 'send_failed', updated_at = NOW()
       WHERE id = $1`,
      [load.id],
    );

    const title = `Shipper confirmation send failed: ${load.origin_city}, ${load.origin_state} → ${load.destination_city}, ${load.destination_state}`;
    const detail =
      `Load ${load.load_id} booked, but the confirmation request could not be sent (${reason}). ` +
      `Confirm the load with the shipper directly (phone or manual email) and record the confirmation.`;

    await db.query(
      `INSERT INTO exceptions (
         load_id, carrier_id, type, severity, title, detail,
         pipeline_load_id, source_module, suggested_action, sla_due_at
       ) VALUES (
         NULL, NULL, 'shipper_confirmation_send_failed', 'high', $1, $2,
         $3, 'shipper_conf_send_failed', $4, NOW() + INTERVAL '1 hour'
       )`,
      [title, detail, load.id, 'Contact the shipper directly to confirm the load in writing, then record it via the ops override.'],
    );

    logger.warn(`[ShipperConfirmation] Load ${load.id} escalated: confirmation send failed (${reason})`);
  }
}
