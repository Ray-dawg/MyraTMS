---
title: Sell-Side Autonomous Loop — Shipper Confirmation, Carrier Brief, and the Paper Trail
id: E2-04
version: 1.0
date: 2026-08-26
owner: Patrice Penda
status: draft
classification: Technical — Engineering + Founder
supersedes: []
depends_on: [E2-01, E2-02, E2-03, T-08, T-09, T-10, T-12, T-22, T-23]
referenced_by: []
note: |
  This document closes the gap E2-02 found and E2-03 named but did not fill:
  M2's carrier cascade was built with no trigger. E2-04 is that trigger, plus
  the written-confirmation discipline that makes it safe to spend money on
  carrier calls. It also revises E2-03 M3's dispatch gate (§9) per the founder's
  decision to require the carrier's signed rate-con back, not just send-attempted.

  Prerequisite that is easy to miss: the shipper voice agent does not capture an
  email address today and the call parser has no field for one. M0 builds that.
  Without it this entire loop has no delivery path.
---

# E2-04 — SELL-SIDE AUTONOMOUS LOOP
## Shipper Confirmation → Carrier Brief → Cascade → Signed Dispatch

| Field | Value |
|---|---|
| Document | E2-04 (sell-side loop closure) |
| Version | 1.0 |
| Date | 2026-08-26 |
| Owner | Patrice Penda, Founder |
| Status | DRAFT |
| Parent | E2-03 (sell-side expansion), E2-02 (investigation) |
| Live path | Yes — new outbound email, new inbound mailbox, new stages, and the first real trigger into M2's cascade |

---

## 1. The gap this closes

E2-03 built M2's carrier cascade and M3's dispatch gate. Neither has ever run, because **nothing enqueues the first `carrier-call-queue` job.** A load reaches `booked` and stops (E2-03 M0 routes it to a human hold). E2-04 is the connective tissue: it takes a `booked` load, obtains written shipper confirmation, repackages the load into a carrier-facing brief, and hands it to the cascade.

The second thing it closes is financial. Today `agreed_rate` is a Claude parse of a phone transcript (E2-02 §2 step 1). E2-03's carrier envelope math derives the carrier ceiling from that number. **Committing to a carrier — and enforcing a margin floor — off an LLM's reading of a phone call is the exposure.** After E2-04, the envelope builds from `confirmed_rate`: a number the shipper typed their name against on a page, snapshotted immutably, with an evidentiary trail behind it.

Framing that governs the whole document: the shipper side and the carrier side are mirrors. Myra buys the load in writing, then sells it in writing. Neither leg advances on a verbal alone.

---

## 2. End-to-end flow

```
'booked'  (shipper agreed a rate by phone — existing, unchanged)
   │
   ├─ M0 precondition: shipper_email captured on the call, parsed from transcript
   │
   ▼
ShipperConfirmationWorker
   ├─ generates SHIPPER-facing rate-con PDF (new generator — see §7)
   ├─ sends email from dispatch@ · subject carries load id
   ├─ body: link to One_pager in confirm-mode (dedicated single-use token)
   └─ stage → 'awaiting_shipper_confirmation'   [SLA clock starts: 2h]
   │
   ├──── T+45min no action ──→ auto-nudge email (once)
   ├──── T+2h  no action ────→ Alert Center: phone-call escalation, human confirms verbally
   │
   ▼
Shipper opens link → sees agreed terms + PDF → types name/title → clicks Confirm
   │                                                     │
   │                                                     └─ clicks Decline (+reason)
   │                                                          → Alert Center: phone-call
   │                                                            escalation. Rate was agreed
   │                                                            verbally; a decline means
   │                                                            something changed and a
   │                                                            human needs to find out what.
   ▼
POST /api/confirmations/:token/confirm
   ├─ writes immutable confirmation snapshot (§6.3)
   ├─ stage → 'shipper_confirmed'
   └─ optional PDF upload on the page (primary paper-trail path)
   │
   ├─── (parallel, non-blocking) shipper replies to the email thread with their PDF
   │     → IMAP poller matches load id in subject, verifies sender domain,
   │       attaches to documents. Never gates a stage. (§8)
   │
   ▼
CarrierBriefCompilerWorker   (mirrors compiler-worker.ts)
   ├─ envelope via calculateCarrierNegotiationParams(confirmed_rate, minMarginFloor)
   ├─ carrier persona via Thompson Sampling — reading the CARRIER slice of personas (§6.4)
   └─ enqueues carrier-call-queue  ◄── THE TRIGGER. First time this queue ever fires.
   │
   ▼
M2 cascade dials (built, E2-03 §6.3) → accept
   │
   ▼
M4 carrier verification (built, E2-03 §8) → carrier rate-con generated + sent
   │
   ▼
Carrier replies to the same thread with signed rate-con
   ├─ IMAP poller matches, verifies sender, attaches
   └─ stage → 'Dispatched'   ◄── REVISED GATE (§9). Signed-back, not send-attempted.
   │
   ├──── carrier signature SLA missed ──→ Alert Center, load stays undispatched
   │
   ▼
Tracking token issued → One_pager flips to tracking-mode → shipper notified
   │
   ▼
Delivery → carrier replies to same thread with POD → poller attaches → 'delivered' → 'scored'
```

**New stages:** `awaiting_shipper_confirmation`, `shipper_confirmed`. Both must be added explicitly to the `pipeline-health` stuck-load query — E2-02 §3.6 item 20 found that check excludes stages by construction, and two fresh stages are precisely how a load disappears silently.

---

## 3. Module map

| Module | Name | Priority | Blocks what |
|---|---|---|---|
| **M0** | Shipper email capture (voice agent brief + call-parser schema field) | **P0 — prerequisite** | Everything. No email, no loop. |
| M1 | Schema: new stages, confirmation snapshot, persona `call_type` split, document types | P0 | M2–M6 |
| M2 | ShipperConfirmationWorker + shipper-facing rate-con generator + IONOS SMTP outbound | P0 | M3 |
| M3 | One_pager confirm-mode + confirm/decline API routes | P0 | M5 |
| M4 | IMAP poller service (rate-con replies, carrier signed rate-cons, PODs) | P1 | M6's gate |
| M5 | CarrierBriefCompilerWorker + carrier-call-queue trigger + 3 carrier Retell agents | P0 | M2 cascade going live |
| M6 | Revised dispatch gate: carrier signed rate-con required (§9) | P1 | — |
| M7 | SLA machinery: nudge, escalation, stuck-load coverage | P0 (ships with M2/M3) | — |

**Out of scope:** manually-created TMS loads (AI-pipeline loads only, v1); shipper POD flows (Driver PWA territory); any change to M2's cascade logic itself.

---

## 4. M0 — Shipper email capture (prerequisite)

E2-02 §3.5 item 17 found the existing tracking send is best-effort — `if (load.shipper_email)` — which means the field exists but is frequently unpopulated. Not every call books a load, so this is a conditional capture, not a blanket one.

**Voice agent (shipper-side, all 3 personas):** add an email-capture step that fires **only on the booking branch** — after the rate is agreed, before close. Confirmation-by-readback is required ("let me read that back to you"), because a transcript-parsed email with one wrong character silently kills the entire downstream loop.

**Call parser:** add `shipper_email` to `CALL_PARSER_SYSTEM_PROMPT`'s extraction schema (`claude-service.ts:245`) and to the parsed-result type. Validate format server-side on write; a malformed or missing email on an otherwise-bookable call routes to Alert Center rather than proceeding to `awaiting_shipper_confirmation` with nowhere to send.

**Fallback for booked loads with no valid email:** Alert Center, `source_module = 'shipper_email_missing'`, suggested action *"Get the shipper's email and enter it to release this load into confirmation."* Do not SMS-fallback in v1 — one delivery channel, done properly.

**Acceptance:** 20 consecutive booking-branch calls in shadow produce a valid, readback-confirmed email in the parsed output. Malformed-email fixture routes to Alert Center, not onward.

---

## 5. M1 — Schema

```sql
-- New stages (add to stages.ts enum + any CHECK constraint on pipeline_loads.stage)
--   'awaiting_shipper_confirmation'
--   'shipper_confirmed'

ALTER TABLE pipeline_loads
  ADD COLUMN IF NOT EXISTS shipper_email                  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS confirmation_token             VARCHAR(64),
  ADD COLUMN IF NOT EXISTS confirmation_token_expires_at  TIMESTAMP,
  ADD COLUMN IF NOT EXISTS confirmation_sent_at           TIMESTAMP,
  ADD COLUMN IF NOT EXISTS confirmation_nudged_at         TIMESTAMP,
  ADD COLUMN IF NOT EXISTS confirmed_at                   TIMESTAMP,
  ADD COLUMN IF NOT EXISTS confirmed_rate                 DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS confirmed_rate_currency        VARCHAR(3),
  ADD COLUMN IF NOT EXISTS confirmation_snapshot          JSONB,
  ADD COLUMN IF NOT EXISTS confirmation_outcome           VARCHAR(20),  -- 'confirmed'|'declined'|'escalated_verbal'
  ADD COLUMN IF NOT EXISTS decline_reason                 TEXT,
  ADD COLUMN IF NOT EXISTS shipper_ratecon_returned_at    TIMESTAMP,
  ADD COLUMN IF NOT EXISTS carrier_ratecon_signed_at      TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_confirmation_token
  ON pipeline_loads(confirmation_token) WHERE confirmation_token IS NOT NULL;

-- Inbound email audit (every message the poller touches, matched or not)
CREATE TABLE IF NOT EXISTS inbound_emails (
    id                 SERIAL PRIMARY KEY,
    message_id         VARCHAR(255) NOT NULL UNIQUE,   -- RFC Message-ID, dedupe key
    from_address       VARCHAR(255) NOT NULL,
    subject            TEXT,
    body_text          TEXT,
    received_at        TIMESTAMP NOT NULL,
    matched_load_id    INTEGER REFERENCES pipeline_loads(id),
    match_method       VARCHAR(30),   -- 'subject_load_id' | 'none'
    sender_verified    BOOLEAN NOT NULL DEFAULT false,
    verification_note  TEXT,
    reply_type         VARCHAR(30),   -- 'shipper_ratecon'|'carrier_ratecon'|'pod'|'unclassified'
    attachment_count   INTEGER DEFAULT 0,
    processed_at       TIMESTAMP,
    quarantined        BOOLEAN NOT NULL DEFAULT false,
    created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inbound_emails_load ON inbound_emails(matched_load_id, received_at DESC);

-- Persona split — closes E2-02 §3.6 item 21 before the carrier compiler ever reads it
ALTER TABLE personas
  ADD COLUMN IF NOT EXISTS call_type VARCHAR(30) NOT NULL DEFAULT 'outbound_shipper';
-- Existing 3 rows keep 'outbound_shipper'. 3 new carrier rows inserted with 'outbound_carrier'.
-- Every read and every Bayesian update must filter on call_type. Without this,
-- carrier outcomes corrupt shipper persona stats from the first carrier call.
```

Document types for `documents`: `shipper_ratecon_sent`, `shipper_ratecon_returned`, `carrier_ratecon_sent`, `carrier_ratecon_signed`, `pod`.

---

## 6. M2/M3 — Confirmation request and the confirm page

### 6.1 The email

From `dispatch@` (IONOS SMTP — the same mailbox the poller watches, so replies land where they were sent from). Subject carries the load ID in a fixed, parseable format: `[MYRA-{load_id}] Rate Confirmation — {origin} to {destination}, {pickup_date}`. Body: agreed terms in plain text, the confirm link, the shipper-facing rate-con PDF attached, and a line asking them to reply to the thread with their own signed copy.

Subject-line matching is fragile by nature — replies get mangled, forwarded, rewritten by mobile clients. The bracketed token is the primary key; the poller also falls back to searching the quoted body. Neither is trusted on its own without sender verification (§8).

### 6.2 Token

**Dedicated confirmation token, not the tracking token.** Single-use, 72h TTL, scoped to the confirm action only. A tracking link is shareable by design and low-sensitivity; a link that binds a company to a freight rate is not the same object. The tracking token is issued *after* confirmation, when One_pager flips to tracking-mode.

### 6.3 The page and the snapshot

One_pager, extended with a state-based render: confirm-mode before ship, tracking-mode after. Confirm-mode shows agreed terms, embedded rate-con PDF, name + title inputs, a Confirm button, a Decline button with a required free-text reason, and a PDF upload control.

On Confirm, store `confirmation_snapshot` as **immutable JSONB**: the exact rate and every term *as rendered on the page at that moment*, plus typed name, title, timestamp, IP, user agent. This is the evidentiary artifact. Reconstructing "what did they agree to" from current DB state is not equivalent — that state will have moved by the time anyone asks.

`confirmed_rate` is written from the snapshot and becomes the source of truth for the carrier envelope. **`agreed_rate` (transcript-parsed) is never used for envelope math again.**

### 6.4 Decline and timeout

The rate was already agreed verbally, so Confirm is the expected path. Both exception paths route to the same place for the same reason — a human needs to make a phone call:

| Path | Action |
|---|---|
| Decline + reason | Alert Center, `severity: high`, `source_module = 'shipper_declined'`. Reason attached. Something changed after the call; a human finds out what. |
| T+45min silent | Auto-nudge email, once. `confirmation_nudged_at` set. |
| T+2h silent | Alert Center, `source_module = 'confirmation_sla_missed'`, suggested action *"Call the shipper and confirm verbally, then release."* |
| Human confirms verbally | New route sets `confirmation_outcome = 'escalated_verbal'`, records who confirmed and when, advances to `shipper_confirmed`. Distinguishable from a page confirmation in every downstream report — a verbal escalation is weaker evidence and should never look identical to a typed confirmation. |

**Shipper emails the PDF but never clicks Confirm:** does not auto-advance. The PDF attaches, the SLA still fires, and a human decides deliberately whether to accept it as confirmation. **Confirms but never sends a PDF:** non-blocking, nudge at 24h, flag on the load, pipeline proceeds.

---

## 7. Shipper-facing rate-con generator

The existing `generateRateCon()` is carrier-facing — built from `top_carrier_id` and the carrier rate (E2-02 §3.5 item 17). A new generator is needed: Myra → shipper, showing the agreed rate, lane, equipment, pickup/delivery windows, and Myra's terms. Reuses the same PDF and Vercel Blob infrastructure. Stored as `shipper_ratecon_sent` and attached to the outbound email.

---

## 8. M4 — IMAP poller

Single `dispatch@` mailbox on IONOS, polled every 60s from Railway alongside the existing workers. Every message touched writes an `inbound_emails` row whether matched or not — silent drops are how paper trails develop holes.

**Sender verification is mandatory before any attachment is written.** Match the sender's domain against the shipper's email on file (or the carrier's contact on file, for carrier-leg replies). Load IDs are guessable and the confirm link goes to an external party; without this check, anyone who knows a load ID can email a document that auto-attaches as the shipper's signed rate-con. Mismatch → `quarantined = true`, Alert Center review, nothing attached automatically.

**Classification** of a verified, matched message by load stage and sender: `awaiting_shipper_confirmation`/`shipper_confirmed` + shipper domain → `shipper_ratecon`. Post-cascade + carrier domain → `carrier_ratecon`. Post-dispatch + carrier domain → `pod`. Ambiguous → `unclassified`, attached and flagged, never guessed.

Dedupe on RFC `Message-ID`. Idempotent by construction — reprocessing the same message is a no-op.

---

## 9. M6 — Revised dispatch gate

**This revises E2-03 M3.** E2-03 specified send-attempted-and-logged as the dispatch precondition. Per your call, v1 requires the carrier's **signed rate-con returned** before `Dispatched`.

The logic is the mirror argument: you are requiring written confirmation from the shipper before spending a dollar on carrier calls. The same discipline says don't flip `Dispatched` — and don't send the shipper a tracking link implying their freight is moving — until the carrier has returned paper. It also closes E2-02's finding (§3.5 item 17) that `loads.status` flips to `'Dispatched'` in the same UPDATE as `carrier_id`, before the rate-con block even executes, with no precondition anywhere.

Carrier signature SLA: 90 minutes from send. Missed → Alert Center, `source_module = 'carrier_ratecon_unsigned'`, load stays undispatched, cascade does **not** auto-advance to the next carrier (that carrier accepted verbally; a human decides whether to chase the signature or move on).

E2-03 §11's spec-reconciliation table gains a row: T-10/E2-03 M3's dispatch gate is superseded by this section.

---

## 10. M5 — Carrier brief compiler

Mirrors `compiler-worker.ts` structurally. Fires on `shipper_confirmed`.

- **Envelope:** `calculateCarrierNegotiationParams(confirmed_rate, minMarginFloor)` — E2-03 §6.5, already specified. Ceiling = `confirmed_rate − minMarginFloor`, enforced as a hard server-side reject in the cascade, not left to the Retell prompt to honor. The goal you described — protect the shipper-side margin, take extra edge where the carrier gives it — is exactly what the target-vs-ceiling spread encodes.
- **Persona:** Thompson Sampling over the `call_type = 'outbound_carrier'` slice only (§5). Three new carrier-facing Retell agents configured in the dashboard, same three-persona structure as the shipper side.
- **Brief contents:** E2-02 §3.3 item 8 found the current carrier dial payload sends Retell almost nothing — IDs only, no load details, no envelope, no carrier company name. The brief fixes that: full load details, envelope, carrier company and contact name, and (from E2-01 M2) `load_source_class` so the agent can answer "is this your freight or are you double-brokering it?" truthfully.
- **Completion enqueues `carrier-call-queue`.** This line is the entire point of E2-04.

---

## 11. Build order

```
Session 0  M0 — voice agent email capture + parser field         [gates everything]
Session 1  M1 — schema, stages, persona split, document types
Session 2  M2 — IONOS SMTP, shipper rate-con generator,
                ShipperConfirmationWorker, M7 SLA machinery
Session 3  M3 — One_pager confirm-mode, confirm/decline routes,
                snapshot write, upload control
Session 4  M4 — IMAP poller, sender verification, classification, quarantine
Session 5  M5 — carrier brief compiler, 3 Retell carrier agents,
                queue trigger  ◄── first live carrier call becomes possible here
Session 6  M6 — revised dispatch gate + spec reconciliation
```

Sessions 0–4 have standalone value with M2's cascade still in shadow: `shipper_confirmed` simply routes to E2-03 M0's human hold. You get the written-confirmation protection and the paper trail weeks before the cascade goes live, and M2 inherits a working trigger instead of needing one built alongside it.

Do not let Claude Code: reuse the tracking token for confirmation; auto-attach an inbound document without sender verification; read or write `personas` without a `call_type` filter; advance a stage on an inbound email; or build envelope math from `agreed_rate` instead of `confirmed_rate`.

---

## 12. Risks

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| E2-R13 | Transcript-parsed email is wrong by one character; loop dies silently | High | Readback confirmation on the call (M0); format validation; delivery-failure bounce handling routes to Alert Center |
| E2-R14 | Forged inbound document attaches as genuine shipper confirmation | High | Mandatory sender-domain verification, quarantine on mismatch (§8) |
| E2-R15 | Confirmation SLA blocks time-sensitive spot freight | Medium | 2h SLA, 45min nudge, phone escalation — tune the SLA down after the first week of real data |
| E2-R16 | Carrier accepts verbally, never signs; load sits undispatched | Medium | 90min signature SLA → Alert Center; human decides chase-vs-move-on (§9) |
| E2-R17 | Persona stats corrupted by carrier outcomes | Medium | `call_type` split ships in M1, before the carrier compiler exists (§5) |
| E2-R18 | Two new stages become silent load graveyards | Medium | Both added explicitly to the stuck-load query (M7); E2-02 §3.6 item 20 is the precedent |
| E2-R19 | IMAP poller double-processes or misses messages | Low | Message-ID dedupe, every touched message writes a row, idempotent by construction |

---

## 13. Metrics

| Metric | Target | Why |
|---|---|---|
| Booking-branch calls yielding a valid email | >95% | M0 is the gate on everything |
| Page-confirm rate (vs. verbal escalation) | >70% | Below this, the email or page has a friction problem |
| Median time booked → shipper_confirmed | <45min | The new latency this loop adds; watch it against pickup urgency |
| Decline rate | <5% | Above this, something is wrong with what the voice agent is agreeing to |
| Shipper rate-con returned (paper trail completeness) | >80% | Non-blocking but it's the audit trail |
| Carrier signed rate-con within SLA | >85% | M6's gate — below this the gate is costing you loads |
| Inbound emails quarantined | reported | Watch for both attack attempts and false positives on legitimate senders |

---

*End of E2-04. Sessions 0–4 ship value with the cascade still in shadow. Session 5 is the first time a carrier call can actually fire.*
