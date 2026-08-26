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
 */

import { put } from '@vercel/blob';
import { withTenant } from '@/lib/db/tenant-context';
import { generateRateCon } from '@/lib/rate-confirmation';
import { attachDocument } from '@/lib/documents';
import { sendRateConfirmationEmail } from '@/lib/email';
import { verifyCarrierAuthority } from '@/lib/verification/carrier-verification';

export type RateConSendStatus = 'sent' | 'failed' | 'skipped_no_email';

export type AiCascadeDispatchResult =
  | {
      outcome: 'dispatched';
      rateCon: { url: string; docId: string };
      rateConSendStatus: RateConSendStatus;
    }
  | {
      outcome: 'escalated';
      reason: 'carrier_not_verified' | 'rate_con_generation_failed';
      verificationReason?: string;
    };

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

  // Only now — after an attempt was made and logged either way — flip
  // dispatch. This is the M3 gate's actual enforcement point.
  await withTenant(tenantId, async (client) => {
    await client.query(
      `UPDATE loads
       SET rate_con_sent_at = NOW(),
           rate_con_send_status = $2,
           rate_con_send_error = $3,
           status = CASE WHEN status = 'Booked' THEN 'Dispatched' ELSE status END,
           updated_at = NOW()
       WHERE id = $1`,
      [loadId, rateConSendStatus, rateConSendError],
    );
  });

  return {
    outcome: 'dispatched',
    rateCon: { url: blob.url, docId: doc.id as string },
    rateConSendStatus,
  };
}
