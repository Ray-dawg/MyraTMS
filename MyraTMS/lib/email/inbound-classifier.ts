/**
 * E2-04 M4 — INBOUND EMAIL CLASSIFIER
 *
 * Pure classification logic for a reply landing in the IONOS inbox, kept
 * separate from lib/email/imap-poller.ts (which does the I/O) so it's
 * testable without any IMAP connection at all — this codebase's established
 * convention (retell-webhook.ts, dispatch-gate.ts, health-checks.ts are all
 * split the same way).
 *
 * Matches purely on subject line, per the linking design this PRD settled
 * on at M0: both outbound emails this pipeline sends carry a load
 * identifier in the subject specifically so a reply can be matched back —
 * sendShipperConfirmationRequestEmail() (lib/email.ts) sends
 * "Rate Confirmation Needed — Load {loadId}" (or its "Reminder:" nudge
 * variant), sendRateConfirmationEmail() (also lib/email.ts, carrier-facing,
 * pre-existing from E2-03 M3) sends "Rate Confirmation — {loadReference}".
 * A reply's mail client typically prepends "Re:"/"Fwd:" (possibly
 * repeated) — stripped before matching.
 */

// "reminder" included alongside the mail-client-added re/fwd prefixes:
// it's literal text this pipeline's own nudge email sends
// (sendShipperConfirmationRequestEmail's `nudge: true` variant), not
// something a mail client adds, but it's noise the same way from the
// classifier's point of view -- strip it so a reply to a nudge matches
// exactly like a reply to the original request.
const REPLY_PREFIX_RE = /^\s*(?:re|fwd?|fw|reminder)\s*:\s*/i;
// Both em-dash (—) and a plain hyphen substitute are accepted — some mail
// clients/webmail composers normalize the em-dash on reply.
const SHIPPER_SUBJECT_RE = /^Rate Confirmation Needed\s*[—-]\s*Load\s+(\S+)/i;
const CARRIER_SUBJECT_RE = /^Rate Confirmation\s*[—-]\s*(\S+)/i;

export type InboundClassification =
  | { type: 'shipper_reply'; loadId: string }
  | { type: 'carrier_reply'; loadReference: string }
  | { type: 'unmatched' };

function stripReplyPrefixes(subject: string): string {
  let s = subject;
  // Bounded loop, not unbounded while(true) — a subject can't plausibly
  // carry more than a handful of forward/reply prefixes; caps worst-case
  // work on adversarial or malformed input.
  for (let i = 0; i < 10 && REPLY_PREFIX_RE.test(s); i++) {
    s = s.replace(REPLY_PREFIX_RE, '');
  }
  return s.trim();
}

export function classifyInboundEmail(subject: string | null | undefined): InboundClassification {
  if (!subject) return { type: 'unmatched' };
  const cleaned = stripReplyPrefixes(subject);

  // Shipper checked first: CARRIER_SUBJECT_RE's own leading "Rate
  // Confirmation" would otherwise also test-match the start of the
  // shipper subject's "Rate Confirmation Needed" text if evaluated first
  // with a looser regex; keeping shipper's more specific pattern first is
  // just defensive ordering, not load-bearing given CARRIER_SUBJECT_RE
  // already requires the dash immediately after "Confirmation".
  const shipperMatch = cleaned.match(SHIPPER_SUBJECT_RE);
  if (shipperMatch) return { type: 'shipper_reply', loadId: shipperMatch[1] };

  const carrierMatch = cleaned.match(CARRIER_SUBJECT_RE);
  if (carrierMatch) return { type: 'carrier_reply', loadReference: carrierMatch[1] };

  return { type: 'unmatched' };
}
