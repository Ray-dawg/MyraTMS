/**
 * E2-03 M3/M4 — the AI-cascade dispatch confirmation gate.
 *
 * Extracted out of app/api/loads/[id]/assign/route.ts so it's testable
 * directly (this codebase's established convention — see
 * lib/pipeline/retell-webhook.ts's handleRetellWebhook() and
 * lib/workers/dispatcher-worker.ts's process(), both tested by calling the
 * lib function directly rather than exercising the Next.js route/queue
 * consumer around them).
 *
 * Scope: this function only ever runs for a load with loads.pipeline_load_id
 * set (an AI-cascade booking) — the route checks that before calling it.
 * Manual human assignments never reach this code at all.
 *
 * PRD §7 (M3): dispatch does not flip to 'Dispatched' until the rate-con
 * send has been attempted and logged. PRD §8 (M4): carrier authority
 * verification is a precondition checked before that send.
 *
 * E2-04 M6 revision: a load whose rate-con was only just sent isn't the
 * same state as one a carrier has actually countersigned. This gate now
 * stops at 'Awaiting Signature' with a 90-minute signature SLA
 * (loads.carrier_signature_due_at) instead of flipping straight to
 * 'Dispatched'. completeDispatchOnSignedRateCon() (below) is what performs
 * the actual flip, called once a signed rate-con is confirmed back --
 * today that means the M4 IMAP poller matching an inbound carrier reply,
 * or a manual ops action. Decision confirmed directly with the user given
 * the blast radius: loads.status is a live CHECK-constrained enum read
 * throughout the whole TMS app (migration 049 adds the new value; only the
 * AI-cascade path below ever produces it -- manual human assignments keep
 * going straight from 'Booked' to 'Dispatched', untouched).
 */

import { put } from '@vercel/blob';
import crypto from 'crypto';
import { withTenant } from '@/lib/db/tenant-context';
import { generateRateCon } from '@/lib/rate-confirmation';
import { attachDocument } from '@/lib/documents';
import { sendRateConfirmationEmail } from '@/lib/email';
import { verifyCarrierAuthority } from '@/lib/verification/carrier-verification';

export type RateConSendStatus = 'sent' | 'failed' | 'skipped_no_email';

const SIGNATURE_SLA_MS = 90 * 60 * 1000; // 90 minutes (E2-04 M6)

export type AiCascadeDispatchResult =
  | {
      outcome: 'awaiting_signature';
      rateCon: { url: string; docId: string };
      rateConSendStatus: RateConSendStatus;
      signatureDueAt: string;
    }
  | {
      outcome: 'escalated';
      reason: 'carrier_not_verified' | 'rate_con_generation_failed';
      verificationReason?: string;
    };

export type CompleteDispatchResult =
  | { outcome: 'dispatched'; loadId: string; trackingToken: string }
  | { outcome: 'not_awaiting_signature'; loadId: string; status: string }
  | { outcome: 'not_found'; loadId: string };

async function escalate(params: {
  tenantId: number;
  loadId: string;
  carrierId: string;
  pipelineLoadId: number;
  type: 'carrier_verification_failed' | 'rate_con_generation_failed';
  title: string;
  detail: string;
  suggestedAction: string;
}): Promise<void> {
  await withTenant(params.tenantId, async (client) => {
    await client.query(
      `INSERT INTO exceptions (
         load_id, carrier_id, type, severity, title, detail,
         pipeline_load_id, source_module, suggested_action, sla_due_at
       ) VALUES ($1, $2, $3, 'high', $4, $5, $6, $3, $7, NOW() + INTERVAL '4 hours')`,
      [params.loadId, params.carrierId, params.type, params.title, params.detail, params.pipelineLoadId, params.suggestedAction],
    );
  });
}

export async function runAiCascadeDispatchGate(params: {
  tenantId: number;
  loadId: string; // TMS loads.id
  carrierId: string;
  pipelineLoadId: number;
  referenceNumber?: string | null;
}): Promise<AiCascadeDispatchResult> {
  const { tenantId, loadId, carrierId, pipelineLoadId, referenceNumber } = params;

  // M4 precondition — check the persisted flag first (cheap), only fall
  // through to a fresh lookup when unverified.
  let verified = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ verified_at: Date | null }>(
      `SELECT verified_at FROM carriers WHERE id = $1`,
      [carrierId],
    );
    return rows[0]?.verified_at != null;
  });

  let verificationReason: string | undefined;
  if (!verified) {
    const result = await verifyCarrierAuthority(carrierId);
    verified = result.verified;
    verificationReason = result.reason ?? undefined;
  }

  if (!verified) {
    await escalate({
      tenantId, loadId, carrierId, pipelineLoadId,
      type: 'carrier_verification_failed',
      title: `Carrier verification failed for load ${loadId}`,
      detail:
        `Automated FMCSA/SAFER verification could not confirm carrier ${carrierId}'s for-hire authority ` +
        `(${verificationReason ?? 'unknown'}). Verify manually via PATCH /api/carriers/${carrierId}/verify before dispatching.`,
      suggestedAction: `Manually verify carrier ${carrierId} or investigate the lookup failure (${verificationReason ?? 'unknown'}).`,
    });
    return { outcome: 'escalated', reason: 'carrier_not_verified', verificationReason };
  }

  // M3 — generate the rate-con BEFORE flipping to Dispatched. If generation
  // itself fails, nothing was even attempted; escalate rather than dispatch
  // silently.
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await generateRateCon(tenantId, loadId);
  } catch (err) {
    await escalate({
      tenantId, loadId, carrierId, pipelineLoadId,
      type: 'rate_con_generation_failed',
      title: `Rate confirmation generation failed for load ${loadId}`,
      detail: `generateRateCon() threw: ${err instanceof Error ? err.message : String(err)}`,
      suggestedAction: 'Generate and send the rate confirmation manually, then dispatch the load by hand.',
    });
    return { outcome: 'escalated', reason: 'rate_con_generation_failed' };
  }

  const filename = `rate-con/${loadId}/RC-${Date.now()}.pdf`;
  const blob = await put(filename, pdfBuffer, { access: 'public', addRandomSuffix: false });
  const doc = await attachDocument({
    tenantId,
    loadId,
    docType: 'Rate Confirmation',
    blobUrl: blob.url,
    fileName: `RC-${referenceNumber || loadId}.pdf`,
    fileSize: pdfBuffer.length,
    uploadedBy: 'system',
  });

  const carrierContact = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ company: string; contact_email: string | null }>(
      `SELECT company, contact_email FROM carriers WHERE id = $1`,
      [carrierId],
    );
    return rows[0] ?? { company: carrierId, contact_email: null };
  });

  let rateConSendStatus: RateConSendStatus;
  let rateConSendError: string | null = null;
  if (carrierContact.contact_email) {
    try {
      const sent = await sendRateConfirmationEmail(
        carrierContact.contact_email,
        carrierContact.company,
        referenceNumber || loadId,
        pdfBuffer,
      );
      rateConSendStatus = sent ? 'sent' : 'failed';
      if (!sent) rateConSendError = 'sendRateConfirmationEmail returned false (SMTP unconfigured or send failed)';
    } catch (err) {
      rateConSendStatus = 'failed';
      rateConSendError = err instanceof Error ? err.message : String(err);
    }
  } else {
    // No email on file — a data-completeness gap, not an AI decision. Logged
    // (rate_con_send_status is set, never left NULL) rather than silently
    // blocking every AI dispatch until every carrier has an email populated.
    rateConSendStatus = 'skipped_no_email';
  }

  // Only now — after an attempt was made and logged either way — move the
  // load to 'Awaiting Signature' and start the 90-minute signature SLA
  // clock. This is the M3 gate's enforcement point; completeDispatchOnSignedRateCon()
  // below is what actually reaches 'Dispatched'.
  const signatureDueAt = new Date(Date.now() + SIGNATURE_SLA_MS);
  await withTenant(tenantId, async (client) => {
    await client.query(
      `UPDATE loads
       SET rate_con_sent_at = NOW(),
           rate_con_send_status = $2,
           rate_con_send_error = $3,
           status = CASE WHEN status = 'Booked' THEN 'Awaiting Signature' ELSE status END,
           carrier_signature_due_at = $4,
           updated_at = NOW()
       WHERE id = $1`,
      [loadId, rateConSendStatus, rateConSendError, signatureDueAt.toISOString()],
    );
  });

  return {
    outcome: 'awaiting_signature',
    rateCon: { url: blob.url, docId: doc.id as string },
    rateConSendStatus,
    signatureDueAt: signatureDueAt.toISOString(),
  };
}

/**
 * Completes an AI-cascade dispatch once the carrier's signed rate-con is
 * confirmed back -- called by the M4 IMAP poller when it matches an inbound
 * reply, or by a manual ops action for a phone-confirmed signature. Flips
 * 'Awaiting Signature' -> 'Dispatched', records the receipt timestamp, and
 * ensures a tracking token exists (idempotent -- mirrors
 * /api/loads/[id]/tracking-token's own DB logic exactly, called directly
 * here rather than over HTTP since this always runs server-side with no
 * request/cookie context to reuse). Does not itself email the shipper --
 * dispatcher-worker.ts already sends the tracking link right after assign,
 * independent of this gate's outcome; this only guarantees a token exists
 * for the rare case that earlier send had no shipper_email to work with.
 *
 * `signedPdfBuffer` is optional so this function is usable and testable
 * before M4's poller exists to supply one -- when present, it's attached
 * as a 'Rate Confirmation' document alongside the one this gate generated,
 * giving the paper trail both the broker's sent copy and the carrier's
 * countersigned copy.
 */
export async function completeDispatchOnSignedRateCon(params: {
  tenantId: number;
  loadId: string;
  signedPdfBuffer?: Buffer;
  signedFileName?: string;
}): Promise<CompleteDispatchResult> {
  const { tenantId, loadId, signedPdfBuffer, signedFileName } = params;

  const load = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM loads WHERE id = $1`,
      [loadId],
    );
    return rows[0] ?? null;
  });
  if (!load) return { outcome: 'not_found', loadId };
  if (load.status !== 'Awaiting Signature') {
    // Idempotent: a re-processed inbound email (e.g. IMAP poller retry, or
    // an ops action after the poller already handled it) should not error
    // or re-flip an already-dispatched load.
    return { outcome: 'not_awaiting_signature', loadId, status: load.status };
  }

  const trackingToken = await withTenant(tenantId, async (client) => {
    const { rows: existing } = await client.query<{ token: string }>(
      `SELECT token FROM tracking_tokens WHERE load_id = $1 LIMIT 1`,
      [loadId],
    );
    if (existing.length > 0) return existing[0].token;

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO tracking_tokens (id, load_id, token, expires_at) VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), loadId, token, expiresAt.toISOString()],
    );
    await client.query(`UPDATE loads SET tracking_token = $1, updated_at = NOW() WHERE id = $2`, [token, loadId]);
    return token;
  });

  await withTenant(tenantId, async (client) => {
    await client.query(
      `UPDATE loads
       SET status = 'Dispatched',
           carrier_signature_received_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND status = 'Awaiting Signature'`,
      [loadId],
    );
  });

  if (signedPdfBuffer) {
    await attachDocument({
      tenantId,
      loadId,
      docType: 'Rate Confirmation',
      blobUrl: (await put(`rate-con/${loadId}/signed-${Date.now()}.pdf`, signedPdfBuffer, { access: 'public', addRandomSuffix: false })).url,
      fileName: signedFileName || `RC-signed-${loadId}.pdf`,
      fileSize: signedPdfBuffer.length,
      uploadedBy: 'system',
    });
  }

  return { outcome: 'dispatched', loadId, trackingToken };
}
