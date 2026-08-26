/**
 * E2-04 M3 — SHIPPER CONFIRMATION ACTIONS
 *
 * Extracted testable lib functions behind the /api/confirmations/[token]
 * routes, matching this codebase's established convention for logic behind
 * a thin Next.js route wrapper (retell-webhook.ts's handleRetellWebhook(),
 * dispatcher-worker.ts's process(), lib/dispatch-gate.ts's
 * runAiCascadeDispatchGate() are all tested the same way — directly, not
 * through their route).
 *
 * Design resolution baked in here: submitConfirmation() and
 * recordVerbalConfirmation() both enqueue carrier-brief-queue directly —
 * there is no other trigger mechanism anywhere in this codebase for "a
 * shipper confirmed, now build the carrier-facing brief." M5's
 * CarrierBriefCompilerWorker (not yet built) is that queue's consumer.
 */

import { Queue } from 'bullmq';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';

const carrierBriefQueue = new Queue('carrier-brief-queue', { connection: redisConnection });

interface ConfirmationSnapshot {
  loadId: string;
  origin: string;
  destination: string;
  pickupDate: string | null;
  deliveryDate: string | null;
  equipmentType: string;
  rate: string | number | null;
  rateCurrency: string | null;
  snapshotAt: string;
}

interface ConfirmationRow {
  id: number;
  load_id: string;
  stage: string;
  confirmation_token: string | null;
  confirmation_token_expires_at: string | Date | null;
  confirmation_snapshot: ConfirmationSnapshot | null;
  confirmation_outcome: string | null;
}

export type ConfirmationLookupResult =
  | { found: false }
  | { found: true; expired: true; loadId: string }
  | { found: true; expired: false; loadId: string; stage: string; alreadyResolved: boolean; snapshot: ConfirmationSnapshot | null };

export type ConfirmationSubmitResult =
  | { outcome: 'not_found' }
  | { outcome: 'expired'; loadId: string }
  | { outcome: 'already_confirmed'; loadId: string }
  | { outcome: 'already_resolved'; loadId: string; stage: string }
  | { outcome: 'confirmed'; loadId: string; pipelineLoadId: number };

export type ConfirmationDeclineResult =
  | { outcome: 'not_found' }
  | { outcome: 'expired'; loadId: string }
  | { outcome: 'already_resolved'; loadId: string; stage: string }
  | { outcome: 'declined'; loadId: string; pipelineLoadId: number };

async function fetchByToken(token: string): Promise<ConfirmationRow | null> {
  const r = await db.query<ConfirmationRow>(
    `SELECT id, load_id, stage, confirmation_token, confirmation_token_expires_at,
            confirmation_snapshot, confirmation_outcome
       FROM pipeline_loads WHERE confirmation_token = $1`,
    [token],
  );
  return r.rows[0] ?? null;
}

// confirmation_token_expires_at is a TIMESTAMP WITHOUT TIME ZONE column, and
// the Neon driver can return it as a bare 'YYYY-MM-DD HH:mm:ss[.ffffff]'
// string with no zone marker. `new Date()` on that string is parsed as
// LOCAL time by the JS engine -- correct only because production runs
// TZ=UTC. Force UTC explicitly here so this doesn't silently drift on any
// deploy target where that stops being true.
function isExpired(row: ConfirmationRow): boolean {
  const raw = row.confirmation_token_expires_at;
  if (!raw) return false;
  const value = raw instanceof Date ? raw : new Date(`${String(raw).replace(' ', 'T')}Z`);
  return value < new Date();
}

/**
 * GET-path lookup for the One_pager confirm-mode page. Never mutates state.
 */
export async function getConfirmationByToken(token: string): Promise<ConfirmationLookupResult> {
  const row = await fetchByToken(token);
  if (!row) return { found: false };
  if (isExpired(row)) return { found: true, expired: true, loadId: row.load_id };

  return {
    found: true,
    expired: false,
    loadId: row.load_id,
    stage: row.stage,
    alreadyResolved: row.stage !== 'awaiting_shipper_confirmation',
    snapshot: row.confirmation_snapshot,
  };
}

/**
 * Shipper clicks "Confirm This Load". Idempotent — a second click after an
 * already-confirmed load returns 'already_confirmed' rather than erroring
 * or re-enqueuing a second carrier-brief job.
 */
export async function submitConfirmation(token: string): Promise<ConfirmationSubmitResult> {
  const row = await fetchByToken(token);
  if (!row) return { outcome: 'not_found' };
  if (isExpired(row)) return { outcome: 'expired', loadId: row.load_id };

  if (row.stage === 'shipper_confirmed') return { outcome: 'already_confirmed', loadId: row.load_id };
  if (row.stage !== 'awaiting_shipper_confirmation') {
    return { outcome: 'already_resolved', loadId: row.load_id, stage: row.stage };
  }

  const snapshot = row.confirmation_snapshot;
  await db.query(
    `UPDATE pipeline_loads
     SET stage = 'shipper_confirmed',
         stage_updated_at = NOW(),
         confirmed_at = NOW(),
         confirmed_rate = $2,
         confirmed_rate_currency = $3,
         confirmation_outcome = 'confirmed',
         updated_at = NOW()
     WHERE id = $1`,
    [row.id, snapshot?.rate ?? null, snapshot?.rateCurrency ?? null],
  );

  await carrierBriefQueue.add('brief', {
    pipelineLoadId: row.id,
    loadId: row.load_id,
    loadBoardSource: '',
    enqueuedAt: new Date().toISOString(),
    priority: 0,
  });

  logger.info(`[ConfirmationActions] Load ${row.id} shipper-confirmed via web link, carrier-brief-queue enqueued`);

  return { outcome: 'confirmed', loadId: row.load_id, pipelineLoadId: row.id };
}

/**
 * Shipper clicks "Decline" / raises an issue with the terms. Terminal for
 * the automated path — escalates to a human rather than guessing at a
 * renegotiation.
 */
export async function declineConfirmation(token: string, reason: string | null): Promise<ConfirmationDeclineResult> {
  const row = await fetchByToken(token);
  if (!row) return { outcome: 'not_found' };
  if (isExpired(row)) return { outcome: 'expired', loadId: row.load_id };
  if (row.stage !== 'awaiting_shipper_confirmation') {
    return { outcome: 'already_resolved', loadId: row.load_id, stage: row.stage };
  }

  await db.query(
    `UPDATE pipeline_loads
     SET stage = 'escalated',
         stage_updated_at = NOW(),
         confirmation_outcome = 'declined',
         decline_reason = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [row.id, reason],
  );

  await db.query(
    `INSERT INTO exceptions (
       load_id, carrier_id, type, severity, title, detail,
       pipeline_load_id, source_module, suggested_action, sla_due_at
     ) VALUES (
       NULL, NULL, 'shipper_declined_confirmation', 'high', $1, $2,
       $3, 'shipper_declined_confirmation', $4, NOW() + INTERVAL '2 hours'
     )`,
    [
      `Shipper declined confirmation: load ${row.load_id}`,
      `Shipper declined the confirmation for load ${row.load_id}${reason ? `. Reason given: ${reason}` : ' (no reason given)'}. Follow up directly — the agreed terms may need renegotiation or the load may need to be released back to the market.`,
      row.id,
      'Call the shipper to resolve the decline reason, then either re-confirm manually or release the load.',
    ],
  );

  logger.warn(`[ConfirmationActions] Load ${row.id} declined by shipper: ${reason ?? 'no reason given'}`);

  return { outcome: 'declined', loadId: row.load_id, pipelineLoadId: row.id };
}

/**
 * Ops-side override: a human confirmed the load verbally (phone call) when
 * the shipper won't use the web link. Same effect as submitConfirmation()
 * but keyed by pipelineLoadId (an authenticated ops user already has the
 * load open, not a token from an email) and requires a `confirmedBy`
 * identity for the audit trail — mirrors manuallyVerifyCarrier()'s
 * human-override precedent (E2-03 M4, lib/verification/carrier-verification.ts).
 */
export async function recordVerbalConfirmation(
  pipelineLoadId: number,
  confirmedBy: string,
  notes: string | null,
): Promise<ConfirmationSubmitResult> {
  const r = await db.query<ConfirmationRow>(
    `SELECT id, load_id, stage, confirmation_token, confirmation_token_expires_at,
            confirmation_snapshot, confirmation_outcome
       FROM pipeline_loads WHERE id = $1`,
    [pipelineLoadId],
  );
  const row = r.rows[0];
  if (!row) return { outcome: 'not_found' };
  if (row.stage === 'shipper_confirmed') return { outcome: 'already_confirmed', loadId: row.load_id };
  if (row.stage !== 'awaiting_shipper_confirmation' && row.stage !== 'escalated') {
    return { outcome: 'already_resolved', loadId: row.load_id, stage: row.stage };
  }

  const snapshot = row.confirmation_snapshot;
  await db.query(
    `UPDATE pipeline_loads
     SET stage = 'shipper_confirmed',
         stage_updated_at = NOW(),
         confirmed_at = NOW(),
         confirmed_rate = COALESCE($2, agreed_rate),
         confirmed_rate_currency = COALESCE($3, agreed_rate_currency),
         confirmation_outcome = 'confirmed_verbal',
         updated_at = NOW()
     WHERE id = $1`,
    [row.id, snapshot?.rate ?? null, snapshot?.rateCurrency ?? null],
  );

  await db.query(
    `INSERT INTO compliance_audit (check_type, result, details, checked_at)
     VALUES ('shipper_verbal_confirmation', 'success', $1, NOW())`,
    [JSON.stringify({ pipeline_load_id: row.id, load_id: row.load_id, confirmed_by: confirmedBy, notes })],
  );

  await carrierBriefQueue.add('brief', {
    pipelineLoadId: row.id,
    loadId: row.load_id,
    loadBoardSource: '',
    enqueuedAt: new Date().toISOString(),
    priority: 0,
  });

  logger.info(`[ConfirmationActions] Load ${row.id} verbally confirmed by ${confirmedBy}, carrier-brief-queue enqueued`);

  return { outcome: 'confirmed', loadId: row.load_id, pipelineLoadId: row.id };
}
