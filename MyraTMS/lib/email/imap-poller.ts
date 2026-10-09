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
 *     a trigger). T-26 adds one additive step here: after the attachment
 *     is stored, extract its terms and compare against what was negotiated
 *     (lib/documents/rate-con-terms.ts) — visibility only, still never a
 *     trigger; a mismatch is recorded and surfaced via T-24's console, not
 *     acted on.
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
import { extractRateConTerms, compareTerms } from '@/lib/documents/rate-con-terms';
import { bridgeToExceptions } from '@/lib/exceptions/bridge';
import { checkSenderAuthorization, isAmbiguousSender } from '@/lib/contract-intake/authorization';
import { extractTenderTerms } from '@/lib/documents/tender-terms';
import { validateTenderedRate } from '@/lib/contract-intake/validate-rate';
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
  let intakeType: string | null = null;
  let senderAuthorized: boolean | null = null;
  let intakeStatus: string | null = null;
  let tenderTenantId: number | null = null;
  let tenderExceptionType: string | null = null;
  let tenderExceptionTitle: string | null = null;
  let tenderExceptionDescription: string | null = null;
  let tenderSuffixEmailId = false;

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
          const attachedDoc = await attachDocument({
            tenantId,
            loadId: documentLoadId,
            docType: 'Shipper Rate Confirmation Reply',
            blobUrl: blob.url,
            fileName,
            fileSize: first.size ?? first.content.length,
            uploadedBy: 'system:imap-poller',
          });

          // T-26 — additive: extract terms from the attachment and compare
          // against what was negotiated. Never blocks or alters the
          // paper-trail attachment above, which remains the M0 design's
          // actual confirmation mechanism (the link click) — this only
          // adds visibility on top of it.
          try {
            const extracted = await extractRateConTerms(first.content);
            const negotiatedRow = await db.query<{
              agreed_rate: string | null; origin_city: string; destination_city: string; pickup_date: string;
            }>(
              `SELECT agreed_rate, origin_city, destination_city, pickup_date FROM pipeline_loads WHERE id = $1`,
              [matchedLoadId],
            );
            const neg = negotiatedRow.rows[0];
            const status = neg && neg.agreed_rate
              ? compareTerms(extracted, {
                  rate: Number(neg.agreed_rate),
                  origin: neg.origin_city,
                  destination: neg.destination_city,
                  pickupDate: new Date(neg.pickup_date).toISOString().slice(0, 10),
                })
              : 'unparseable';

            await db.query(
              `UPDATE documents SET parsed_terms = $1, terms_match_status = $2 WHERE id = $3`,
              [extracted ? JSON.stringify(extracted) : null, status, attachedDoc.id],
            );

            if (status === 'mismatch') {
              await bridgeToExceptions({
                tenantId,
                sourceModule: 'document_terms_mismatch',
                exceptionType: 'rate_con_terms_mismatch',
                title: `Rate con terms mismatch — pipeline load ${matchedLoadId}`,
                description: `Shipper's returned rate con terms don't match what was negotiated. Parsed: ${JSON.stringify(extracted)}`,
                context: {},
                pipelineLoadId: matchedLoadId,
                loadId: null,
                carrierId: null,
              });
            }
          } catch (err) {
            logger.error(`[imap-poller] term extraction/comparison failed for load ${classification.loadId}`, err);
          }
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
    // T-30 — an unsolicited freight tender never matches either known reply
    // pattern; check the sender against the whitelist BEFORE any extraction
    // runs (spec §10 step 2 — never spend a token on a sender that was never
    // going to be accepted).
    verificationNote = 'subject did not match any known pattern';
    let authorized = false;
    let authTenantId: number | null = null;
    try {
      const authResult = await checkSenderAuthorization(fromAddress);
      // An ambiguous sender is NOT an authorization — it fails closed into the
      // same manual-review branch — but the operator has to be told the real
      // cause, which is the opposite of "on no whitelist".
      const ambiguous = isAmbiguousSender(authResult) ? authResult : null;
      const authorization = isAmbiguousSender(authResult) ? null : authResult;

      if (!authorization) {
        intakeStatus = 'unauthorized_sender';
        tenderTenantId = await getMyraTenantId(); // no authorization row to source a tenant from — same "effectively Myra-only mailbox" reality T-19/T-25/T-27 document
        tenderExceptionType = 'unauthorized_tender_sender';
        // No email-id suffix here: the title is unique per sender, so the
        // bridge's type+title dedup collapses repeats while one is open.
        // (A separate severity rule for this case is deferred to T-30b.)
        // The two causes get different titles on purpose: they need different
        // operator actions, so dedup must not collapse one into the other.
        tenderExceptionTitle = ambiguous
          ? `Ambiguous freight-tender sender: ${fromAddress}`
          : `Unauthorized freight-tender sender: ${fromAddress}`;
        tenderExceptionDescription = ambiguous
          ? `An email from ${fromAddress} is on MORE THAN ONE tenant's contract_shipper_authorizations whitelist `
            + `(tenants ${ambiguous.tenantIds.join(', ')}; authorizations ${ambiguous.authorizationIds.join(', ')}). `
            + 'One shipper email maps to at most one tenant, so no tenant can be attributed and the tender was not parsed. '
            + 'Deactivate all but the correct authorization, then re-send the tender.'
          : `An email from ${fromAddress} did not match any known reply pattern and is not on any tenant's contract_shipper_authorizations whitelist.`;
      } else {
        authorized = true;
        authTenantId = Number(authorization.tenantId); // Neon BIGINT -> string
        intakeType = 'freight_tender';
        senderAuthorized = true;
        // First PDF only (by content type or .pdf filename); no PDF is treated
        // exactly like no attachment.
        const pdf = attachments.find(
          (a) => a.contentType === 'application/pdf' || (a.filename ?? '').toLowerCase().endsWith('.pdf'),
        );
        if (pdf) {
          tenderTenantId = authTenantId;
          tenderExceptionType = 'tender_pending_approval';
          intakeStatus = 'pending_review';
          tenderSuffixEmailId = true;
          const extracted = await extractTenderTerms(pdf.content);
          if (extracted) {
            const validation = await validateTenderedRate(authTenantId!, extracted, authorization.marginFloorOverrideAmount);
            tenderExceptionTitle = validation.acceptable
              ? `New tender ready — approve to inject (from ${fromAddress})`
              : `Tender below margin floor — accept anyway or decline (from ${fromAddress})`;
            tenderExceptionDescription = `Parsed tender: ${JSON.stringify(extracted)}. ${validation.reason}`;
          } else {
            tenderExceptionTitle = `Tender could not be parsed — manual review needed (from ${fromAddress})`;
            tenderExceptionDescription = 'Claude-based extraction failed or returned no usable fields.';
          }
        }
        // Authorized sender, no PDF: nothing to review yet — intake_status
        // stays null, no exception is raised. A follow-up email with the actual
        // tender PDF will be processed on its own next poll.
      }
    } catch (err) {
      // The message is already flagged \Seen, so a throw here must not lose
      // the tender: fall through to the shared INSERT and route to manual review.
      logger.error(`[imap-poller] tender processing failed for ${fromAddress}`, err);
      const msg = err instanceof Error ? err.message : String(err);
      // Authorization may not have completed (the lookup itself threw); the
      // email must still be visible in the console, so fall back to Myra.
      tenderExceptionType = 'tender_pending_approval';
      intakeStatus = 'pending_review';
      tenderSuffixEmailId = true;
      tenderExceptionTitle = `Tender could not be parsed — manual review needed (from ${fromAddress})`;
      tenderExceptionDescription = `Tender processing failed: ${msg}`;
      try {
        tenderTenantId = authorized ? authTenantId : await getMyraTenantId();
      } catch (tenantErr) {
        logger.error('[imap-poller] could not resolve tenant for failed tender', tenantErr);
      }
    }
  }

  if (quarantined) result.quarantined++;

  const inserted = await db.query<{ id: number }>(
    `INSERT INTO inbound_emails (
       message_id, from_address, subject, body_text, received_at,
       matched_load_id, match_method, sender_verified, verification_note,
       reply_type, attachment_count, processed_at, quarantined,
       intake_type, sender_authorized, intake_status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12, $13, $14, $15)
     RETURNING id`,
    [
      messageId, fromAddress, subject, bodyText.slice(0, 20000), receivedAt,
      matchedLoadId, matchMethod, senderVerified, verificationNote,
      replyType, attachments.length, quarantined,
      intakeType, senderAuthorized, intakeStatus,
    ],
  );

  if (tenderExceptionType && tenderTenantId !== null) {
    const emailId = inserted.rows[0].id;
    const fullTitle = tenderSuffixEmailId ? `${tenderExceptionTitle} [email #${emailId}]` : tenderExceptionTitle!;
    try {
      const bridged = await bridgeToExceptions({
        tenantId: tenderTenantId,
        sourceModule: 'contract_intake',
        exceptionType: tenderExceptionType,
        // Authorized tenders get the email id so distinct tenders from one
        // sender don't collapse under the bridge's type+title dedup.
        title: fullTitle,
        description: tenderExceptionDescription!,
        context: {},
        pipelineLoadId: null,
        loadId: null,
        carrierId: null,
        inboundEmailId: emailId,
      });
      if (!bridged) {
        // False is also the bridge's normal dedup path (an identical exception
        // is already open) -- only flag the row when none exists.
        const open = await db.query(
          `SELECT 1 FROM exceptions WHERE tenant_id = $1 AND type = $2 AND title = $3 AND status = 'active' LIMIT 1`,
          [tenderTenantId, tenderExceptionType, fullTitle],
        );
        if (open.rows.length === 0) throw new Error('bridgeToExceptions created no exception (no classification rule?)');
      }
    } catch (err) {
      logger.warn(`[imap-poller] tender exception not created for inbound email ${emailId}: ${err instanceof Error ? err.message : String(err)}`);
      try {
        await db.query(`UPDATE inbound_emails SET intake_status = 'bridge_failed' WHERE id = $1`, [emailId]);
      } catch (updErr) {
        logger.error(`[imap-poller] could not mark inbound email ${emailId} bridge_failed`, updErr);
      }
    }
  }
}
