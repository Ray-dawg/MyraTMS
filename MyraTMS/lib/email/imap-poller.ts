/**
 * E2-04 M4 — INBOUND EMAIL IMAP POLLER
 *
 * Polls the IONOS mailbox for unseen messages, classifies each one
 * (lib/email/inbound-classifier.ts), and writes an inbound_emails row for
 * EVERY message it touches — matched or not. Per PRD §8: silent drops are
 * exactly how a paper trail develops a hole, so an unmatched or
 * unverifiable message still gets a row (quarantined=true), never just
 * ignored.
 *
 * Two reply types, two very different actions:
 *   - shipper_reply: paper trail only (per the M0 design decision — the
 *     shipper's actual confirmation is the CLICK on the confirm link;
 *     lib/confirmation-actions.ts already handles that. This reply is
 *     stored for human review and attached to the load's documents, never
 *     a trigger).
 *   - carrier_reply: DOES drive a state transition when the sender is
 *     verified and a PDF is attached — calls
 *     completeDispatchOnSignedRateCon() (lib/dispatch-gate.ts, M6), the
 *     one and only caller of that function today.
 *
 * `pollInbox()` takes an injected client conforming to ImapClientLike
 * rather than constructing a real ImapFlow connection itself, so it's
 * fully testable with a fake client and no live mailbox — this codebase's
 * established convention for I/O-adjacent logic (see dispatch-gate.test.ts
 * mocking @vercel/blob's put() the same way). scripts/run-imap-poller.ts
 * is what wires a real ImapFlow instance in production.
 */

import { simpleParser } from 'mailparser';
import { put } from '@vercel/blob';
import { db } from '@/lib/pipeline/db-adapter';
import { withTenant } from '@/lib/db/tenant-context';
import { getMyraTenantId } from '@/lib/tenants/get-myra-tenant-id';
import { logger } from '@/lib/logger';
import { attachDocument } from '@/lib/documents';
import { completeDispatchOnSignedRateCon } from '@/lib/dispatch-gate';
import { classifyInboundEmail } from './inbound-classifier';

export interface ImapEnvelopeAddress {
  address: string | null;
  name?: string | null;
}

export interface ImapFetchedMessage {
  uid: number;
  envelope: { subject: string | null; from: ImapEnvelopeAddress[] };
  source: Buffer;
}

/**
 * Minimal subset of ImapFlow's real API this poller needs. A real
 * ImapFlow instance satisfies this interface as-is (structurally), so
 * scripts/run-imap-poller.ts can pass one directly with no adapter.
 */
export interface ImapClientLike {
  connect(): Promise<void>;
  mailboxOpen(path: string): Promise<unknown>;
  search(query: Record<string, unknown>): Promise<number[]>;
  fetchOne(uid: number, options: Record<string, unknown>): Promise<ImapFetchedMessage | false>;
  messageFlagsAdd(uid: number, flags: string[]): Promise<boolean>;
  logout(): Promise<void>;
}

export interface PollResult {
  processed: number;
  matched: number;
  quarantined: number;
}

export async function pollInbox(client: ImapClientLike, opts: { mailboxPath?: string } = {}): Promise<PollResult> {
  const result: PollResult = { processed: 0, matched: 0, quarantined: 0 };

  await client.connect();
  try {
    await client.mailboxOpen(opts.mailboxPath ?? 'INBOX');
    const uids = await client.search({ seen: false });

    for (const uid of uids) {
      try {
        await processMessage(client, uid, result);
      } catch (err) {
        logger.error(`[imap-poller] Failed processing uid ${uid}`, err);
      }
    }
  } finally {
    await client.logout();
  }

  return result;
}

async function processMessage(client: ImapClientLike, uid: number, result: PollResult): Promise<void> {
  const msg = await client.fetchOne(uid, { source: true, envelope: true, uid: true });
  if (!msg) return;
  result.processed++;

  const parsed = await simpleParser(msg.source);
  const subject = parsed.subject ?? msg.envelope.subject ?? null;
  const fromAddress = (parsed.from?.value?.[0]?.address ?? msg.envelope.from?.[0]?.address ?? '').toLowerCase();
  const bodyText = parsed.text ?? '';
  // mailparser's parsed.messageId includes the RFC-822 angle brackets
  // (e.g. '<abc@host>') -- stripped here so inbound_emails.message_id
  // stores a plain identifier, not a wire-format artifact a future
  // query would need to remember to bracket.
  const messageId = (parsed.messageId ?? `imap-uid-${uid}-${Date.now()}`).replace(/^<|>$/g, '');
  const receivedAt = parsed.date ?? new Date();
  const attachments = parsed.attachments ?? [];

  // Always mark seen once fetched, regardless of outcome — an unmatched or
  // errored message shouldn't be re-polled forever.
  await client.messageFlagsAdd(uid, ['\\Seen']);

  const already = await db.query(`SELECT 1 FROM inbound_emails WHERE message_id = $1`, [messageId]);
  if (already.rows.length > 0) return; // already processed on a prior poll

  const classification = classifyInboundEmail(subject);

  let matchedLoadId: number | null = null;
  let matchMethod: string | null = null;
  let replyType: string | null = null;
  let senderVerified = false;
  let verificationNote: string | null = null;
  let quarantined = true;

  if (classification.type === 'shipper_reply') {
    replyType = 'shipper_confirmation_reply';
    const row = await db.query<{ id: number; shipper_email: string | null }>(
      `SELECT id, shipper_email FROM pipeline_loads WHERE load_id = $1`,
      [classification.loadId],
    );
    if (row.rows[0]) {
      matchedLoadId = row.rows[0].id;
      matchMethod = 'subject_load_id';
      senderVerified = !!row.rows[0].shipper_email && row.rows[0].shipper_email.toLowerCase() === fromAddress;
      verificationNote = senderVerified ? null : 'from-address does not match shipper_email on file';
      quarantined = false;
      result.matched++;

      // Paper trail only — per the M0 design decision, this reply never
      // drives a state transition (the confirm-link click already does
      // that via lib/confirmation-actions.ts). Attach whatever the shipper
      // sent back for human review.
      if (attachments.length > 0) {
        try {
          const tenantId = await getMyraTenantId();
          // documents.related_to has no FK -- but every OTHER document row
          // for a load is keyed by the TMS loads.id, not the pipeline's own
          // board-source load_id string, and a reply can arrive well after
          // dispatch already created that TMS row. Prefer it when it
          // exists so this document is actually discoverable from the
          // normal load-detail document view; fall back to the pipeline
          // load_id (still better than dropping the attachment) when a TMS
          // row doesn't exist yet.
          const tmsLoad = await withTenant(tenantId, async (tenantClient) => {
            const { rows } = await tenantClient.query<{ id: string }>(
              `SELECT id FROM loads WHERE pipeline_load_id = $1 LIMIT 1`,
              [matchedLoadId],
            );
            return rows[0]?.id ?? null;
          });
          const documentLoadId = tmsLoad ?? classification.loadId;

          const first = attachments[0];
          const fileName = first.filename || `shipper-reply-${classification.loadId}.pdf`;
          const blob = await put(
            `inbound/shipper-reply/${classification.loadId}/${Date.now()}-${fileName}`,
            first.content,
            { access: 'public', addRandomSuffix: false },
          );
          await attachDocument({
            tenantId,
            loadId: documentLoadId,
            docType: 'Shipper Rate Confirmation Reply',
            blobUrl: blob.url,
            fileName,
            fileSize: first.size ?? first.content.length,
            uploadedBy: 'system:imap-poller',
          });
        } catch (err) {
          logger.error(`[imap-poller] Failed attaching shipper reply document for load ${classification.loadId}`, err);
        }
      }
    } else {
      verificationNote = `no pipeline_loads row for load_id '${classification.loadId}'`;
    }
  } else if (classification.type === 'carrier_reply') {
    replyType = 'carrier_ratecon_reply';
    const tenantId = await getMyraTenantId();
    const carrierMatch = await withTenant(tenantId, async (tenantClient) => {
      const { rows } = await tenantClient.query<{
        id: string; pipeline_load_id: number | null; carrier_id: string | null; status: string;
      }>(
        `SELECT id, pipeline_load_id, carrier_id, status FROM loads WHERE id = $1 OR reference_number = $1 LIMIT 1`,
        [classification.loadReference],
      );
      return rows[0] ?? null;
    });

    if (carrierMatch) {
      matchedLoadId = carrierMatch.pipeline_load_id;
      matchMethod = 'subject_load_reference';
      quarantined = false;
      result.matched++;

      const carrierContact = carrierMatch.carrier_id
        ? await withTenant(tenantId, async (tenantClient) => {
            const { rows } = await tenantClient.query<{ contact_email: string | null }>(
              `SELECT contact_email FROM carriers WHERE id = $1`,
              [carrierMatch.carrier_id],
            );
            return rows[0]?.contact_email ?? null;
          })
        : null;
      senderVerified = !!carrierContact && carrierContact.toLowerCase() === fromAddress;
      verificationNote = senderVerified ? null : 'from-address does not match carriers.contact_email on file';

      // The one and only trigger action this poller performs: a verified
      // carrier reply with an attached signed rate-con, on a load still
      // awaiting one, completes the dispatch (E2-04 M6).
      if (senderVerified && attachments.length > 0 && carrierMatch.status === 'Awaiting Signature') {
        const first = attachments[0];
        try {
          await completeDispatchOnSignedRateCon({
            tenantId,
            loadId: carrierMatch.id,
            method: 'email_verified',
            signedPdfBuffer: first.content,
            signedFileName: first.filename || `RC-signed-${carrierMatch.id}.pdf`,
          });
        } catch (err) {
          logger.error(`[imap-poller] completeDispatchOnSignedRateCon failed for load ${carrierMatch.id}`, err);
        }
      } else if (!senderVerified) {
        logger.warn(`[imap-poller] Carrier reply for load ${carrierMatch.id} not sender-verified — dispatch not completed automatically`);
      }
    } else {
      verificationNote = `no loads row matches reference '${classification.loadReference}'`;
    }
  } else {
    verificationNote = 'subject did not match any known pattern';
  }

  if (quarantined) result.quarantined++;

  await db.query(
    `INSERT INTO inbound_emails (
       message_id, from_address, subject, body_text, received_at,
       matched_load_id, match_method, sender_verified, verification_note,
       reply_type, attachment_count, processed_at, quarantined
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12)`,
    [
      messageId, fromAddress, subject, bodyText.slice(0, 20000), receivedAt,
      matchedLoadId, matchMethod, senderVerified, verificationNote,
      replyType, attachments.length, quarantined,
    ],
  );
}
