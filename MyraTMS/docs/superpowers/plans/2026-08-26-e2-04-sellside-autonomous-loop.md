# E2-04 — Sell-Side Autonomous Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the missing trigger into M2's carrier cascade — shipper written confirmation, a real carrier-facing negotiation brief, an inbound-email paper trail, and a revised dispatch gate requiring the carrier's signed rate-con back. This is what E2-03 M2/M3/M4 have been waiting for since they shipped.

**Architecture:** Mirrors E2-03's own worker/queue/gate patterns throughout — `ShipperConfirmationWorker` and `CarrierBriefCompilerWorker` both extend `BaseWorker` exactly like `compiler-worker.ts`; the IMAP poller is a new standalone service booted alongside the existing workers in `run-workers.ts`; SLA timers reuse the exact `{ delay: ms }` BullMQ pattern M2's voicemail retry already established. One_pager gets a confirm-mode branch ahead of its existing tracking-mode fetch, keyed off a dedicated confirmation token distinct from the tracking token.

**Tech Stack:** TypeScript, BullMQ, Neon, `imapflow` (new dependency — no IMAP capability exists in this repo today), `nodemailer` (already present, IONOS SMTP), Vitest.

**Spec:** `Engine 2/E2-04_SellSide_Autonomous_Loop_PRD.md` — the authoritative source; this plan sequences it into buildable tasks. Read it before touching any module below; this plan does not restate its reasoning, only its sequencing.

## Global Constraints (from the PRD's own "do not let Claude Code" list, §11)

- Never reuse the tracking token for confirmation — dedicated token, separate table/column, 72h TTL, single-use.
- Never auto-attach an inbound document without sender-domain verification passing first.
- Never read or write `personas` without a `call_type` filter, from the moment the column exists (M1 onward) — this is why the persona split ships in M1, before the carrier compiler (M5) is written, not after.
- Never advance a pipeline stage from an inbound email — only the page-click (or verbal-escalation route) advances `awaiting_shipper_confirmation` → `shipper_confirmed`; only the carrier-side signed-rate-con detection advances to `Dispatched` (M6).
- Never build envelope math from `agreed_rate` (transcript-parsed) — `confirmed_rate` (page-snapshot) is the only source once M3 ships.
- Migration numbering: next free number in `MyraTMS/scripts/` is **046** — 044/045 are a concurrent peer session's uncommitted work (T-20/T-21), not touched by this plan.
- `imapflow` is a new npm dependency — install it in Task 12, not before (keeps the diff that adds it colocated with its first real usage).

---

## Task 1 (M0): Call-parser shipper-email field

**Files:**
- Modify: `lib/pipeline/claude-service.ts:171-220` (`CallParseResultSchema`), `:245-260` region (prompt field list, actual bullet insertion near `:697`)
- Modify: `lib/pipeline/retell-types.ts:124-168` (`CallResult` interface)
- Test: `lib/pipeline/__tests__/claude-service.test.ts` (extend if it exists; check first) or a new focused test asserting the schema accepts/round-trips `shipper_email`

**Note on scope:** the PRD's M0 also wants the Retell voice agent itself to ask for + read back the email mid-call. That prompt lives in the Retell dashboard (confirmed: no code in this repo builds shipper-call conversational prompts — `compiler-worker.ts` only selects a pre-existing `retell_agent_id`). **That half of M0 is an operator dashboard task, out of this plan's reach** — flagged in the completion tracker as needing your action, same as E2-03's Retell persona setup. This task covers only the code half: the parser schema has to have somewhere to put the email once the agent starts saying it.

- [ ] Add `shipper_email: z.string().nullable(),` to `CallParseResultSchema` (claude-service.ts, right before the schema's closing `});`).
- [ ] Add a `shipper_email` bullet to the prompt's field list (near claude-service.ts:697, matching the existing `decision_maker_referral` bullet's style) so Claude knows to look for it in the transcript.
- [ ] Add `shipper_email: string | null;` to `CallResult` (retell-types.ts, before `analysis_notes: string;`).
- [ ] Format validation: add a small `isValidEmail(s: string): boolean` guard (simple regex, not a full RFC validator) used at the write site in Task 2 below — malformed email routes to Alert Center per PRD §4, not silently discarded.
- [ ] `pnpm tsc --noEmit` clean.
- [ ] Commit: `E2-04 M0: shipper_email field on the call-parser schema`.

---

## Task 2 (M1): Schema — stages, confirmation columns, inbound_emails, persona split

**Files:**
- Create: `scripts/046-e2-04-sellside-loop-schema.sql`
- Create: `scripts/verify-046-e2-04-sellside-loop-schema.ts` (mirrors `verify-043-m3-m4-dispatch-gate.ts`'s shape)
- Modify: `lib/pipeline/stages.ts` (add `'awaiting_shipper_confirmation'`, `'shipper_confirmed'` to the `PipelineStage` enum and `VALID_TRANSITIONS`)
- Modify: `lib/documents.ts:4` (`ALLOWED_DOC_TYPES` — add `'Shipper Rate Confirmation Sent'`, `'Shipper Rate Confirmation Returned'`, `'Carrier Rate Confirmation Signed'` — reusing the existing `'Rate Confirmation'`/`'POD'` values where the PRD's own doc-type list overlaps what already exists, adding new ones only where it doesn't)
- Modify: `app/api/documents/upload/route.ts` if it duplicates the type list (confirm during implementation — scout flagged this as unread)

**Migration (idempotent, `ADD COLUMN IF NOT EXISTS` throughout, matching 041-045's established style):**

Per PRD §5 exactly — `pipeline_loads` gains `shipper_email`, `confirmation_token` (unique partial index, `WHERE confirmation_token IS NOT NULL`), `confirmation_token_expires_at`, `confirmation_sent_at`, `confirmation_nudged_at`, `confirmed_at`, `confirmed_rate`, `confirmed_rate_currency`, `confirmation_snapshot` (JSONB), `confirmation_outcome`, `decline_reason`, `shipper_ratecon_returned_at`, `carrier_ratecon_signed_at`. New `inbound_emails` table exactly per PRD §5's DDL. `personas.call_type VARCHAR(30) NOT NULL DEFAULT 'outbound_shipper'`, then a follow-up `UPDATE`/seed inserting 3 new `call_type='outbound_carrier'` persona rows (placeholder `retell_agent_id_en` values — real IDs land when the operator configures the 3 carrier Retell agents, same deferred-config pattern the original 3 shipper personas used at Engine 2 bootstrap).

**Stage machine note:** confirmed via scout — `pipeline_loads.stage` has no DB CHECK constraint, free `VARCHAR(30)`, validated only by `VALID_TRANSITIONS` in `stages.ts`. New stages need no migration for the column itself, only the TypeScript enum + transitions map. New transitions: `booked → awaiting_shipper_confirmation`, `awaiting_shipper_confirmation → shipper_confirmed`, `awaiting_shipper_confirmation → escalated` (decline or SLA-missed), `shipper_confirmed → briefed` (or wherever the carrier brief compiler's own `nextStage` lands it — decide exact value in Task 6, wire the transition here once that's settled to avoid a second stages.ts edit).

- [ ] Write and apply migration 046 (same live-Neon apply pattern as 043: split into individual non-transactional statements against `@neondatabase/serverless`'s `.query()`, since it rejects multi-statement text — confirmed this session).
- [ ] Write and run the verify script.
- [ ] Update `stages.ts` enum + `VALID_TRANSITIONS`.
- [ ] Update `ALLOWED_DOC_TYPES`.
- [ ] `pnpm tsc --noEmit` clean.
- [ ] Commit: `E2-04 M1: schema — confirmation columns, inbound_emails, persona call_type split`.

---

## Task 3 (M1 continued): Persona reads filtered by call_type everywhere

**Files:**
- Modify: `lib/workers/compiler-worker.ts:466-470` (`selectPersonaFromDb()` — add `AND call_type = 'outbound_shipper'` to the existing query, since this file is shipper-only and must never accidentally draw a carrier persona row)
- Modify: `lib/workers/feedback-worker.ts` (`updatePersonaBayesian()` — same filter, shipper-only)
- Test: extend `__tests__/pipeline/feedback.test.ts` and the compiler's own persona test (if one exists — check) to assert a `call_type='outbound_carrier'` row is never selected/updated by the shipper-side path even when present

This closes PRD risk E2-R17 (persona stats corruption) by construction, before Task 8's `CarrierBriefCompilerWorker` ever writes a carrier persona row to select from.

- [ ] Add the filter to both existing read sites.
- [ ] Add regression tests seeding one shipper + one carrier persona row, asserting shipper-path queries never touch the carrier row.
- [ ] `pnpm tsc --noEmit` clean, tests pass.
- [ ] Commit: `E2-04 M1: filter every existing persona read by call_type='outbound_shipper'`.

---

## Task 4 (M2 part 1): Shipper-facing rate-con PDF generator

**Files:**
- Create: `lib/shipper-rate-confirmation.ts` (new file, sibling to the existing `lib/rate-confirmation.ts`, not a modification of it — that one is carrier-facing per its own header and E2-02's finding; keep them separate per the PRD's explicit "Myra → shipper" framing)
- Test: `__tests__/lib/shipper-rate-confirmation.test.ts`

Reuses the same `pdfkit` + `PassThrough` streaming pattern as `lib/rate-confirmation.ts:1-51` almost verbatim, different content: agreed rate (from `confirmed_rate` once set, or the pre-confirmation `agreed_rate` for the *unsigned* copy attached to the initial request email — the page itself is what produces the immutable snapshot, not this PDF), lane, equipment, pickup/delivery windows, Myra's terms. Same `withTenant` DB read pattern.

- [ ] Implement `generateShipperRateCon(tenantId, pipelineLoadId): Promise<Buffer>`.
- [ ] Tests: PDF buffer is non-empty and starts with the PDF magic bytes (matching whatever minimal assertion, if any, an existing rate-con test uses — check `lib/rate-confirmation.ts`'s own test coverage first, mirror its depth).
- [ ] `pnpm tsc --noEmit` clean, tests pass.
- [ ] Commit: `E2-04 M2: shipper-facing rate confirmation PDF generator`.

---

## Task 5 (M2 part 2): ShipperConfirmationWorker

**Files:**
- Create: `lib/workers/shipper-confirmation-worker.ts`
- Modify: `lib/pipeline/queues.ts` (new `SHIPPER_CONFIRMATION_QUEUE_CONFIG`, `delayable: true` for the nudge/escalation timers, registered in `ALL_QUEUE_CONFIGS` + `getQueuesByOrder()`)
- Test: `__tests__/pipeline/shipper-confirmation-worker.test.ts`

**Design:** extends `BaseWorker`, `expectedStage: 'booked'`, `nextStage: undefined` (mirrors `dispatcher-worker.ts`'s reasoning — this worker's real state changes happen via direct writes in `process()`/`updatePipelineLoad()` override, not the base-class auto-advance, because the stage write here needs the token fields set atomically alongside it).

`process()`: validate `shipper_email` present and format-valid (Task 1's guard) — if missing/invalid, escalate to Alert Center (`source_module='shipper_email_missing'`) per PRD §4, do not proceed. Generate `confirmation_token` (`crypto.randomBytes(32).toString('hex')`, same method the existing tracking-token route uses), set `confirmation_token_expires_at = NOW() + 72h`, generate the shipper rate-con PDF (Task 4), send the email via a new `sendShipperConfirmationRequestEmail()` in `lib/email.ts` (mirrors `sendRateConfirmationEmail()`'s attachment pattern, subject format exactly per PRD §6.1: `[MYRA-{load_id}] Rate Confirmation — {origin} to {destination}, {pickup_date}`), advance stage to `'awaiting_shipper_confirmation'`, set `confirmation_sent_at`.

**SLA follow-ups**, enqueued from the same `process()` call using the delayed-job pattern confirmed this session (`{ delay: ms }` on the same or a dedicated queue — reuse this worker's own queue with a `job.name` discriminator, e.g. `'nudge'` and `'escalate'`, rather than two more queues):
- `+45min` delayed job: if still `stage='awaiting_shipper_confirmation'` when it fires, send one nudge email, set `confirmation_nudged_at`. No-op if the stage already moved on.
- `+2h` delayed job: if still `stage='awaiting_shipper_confirmation'`, write an `exceptions` row (`source_module='confirmation_sla_missed'`, mirrors `dispatch-gate.ts`'s `escalate()` helper shape) rather than advancing anything.

- [ ] Queue config + registration.
- [ ] Worker implementation (main send + both delayed follow-ups as separate job handlers inside the same `process()`, discriminated by `job.name`, or three small private methods dispatched from `process()` — pick whichever keeps `process()` under ~40 lines).
- [ ] Tests: happy path (email sent, stage advances, both delayed jobs land in the queue with correct delay); missing-email escalates instead of sending; nudge job no-ops if already confirmed; 2h-escalation job no-ops if already confirmed, writes exceptions row if not.
- [ ] `pnpm tsc --noEmit` clean, tests pass.
- [ ] Commit: `E2-04 M2: ShipperConfirmationWorker + SLA nudge/escalation timers`.

---

## Task 6 (M3): Confirm/decline API routes (MyraTMS side)

**Files:**
- Create: `app/api/confirmations/[token]/route.ts` (GET — fetch confirm-page data)
- Create: `app/api/confirmations/[token]/confirm/route.ts` (POST)
- Create: `app/api/confirmations/[token]/decline/route.ts` (POST)
- Create: `app/api/confirmations/[token]/verbal/route.ts` (POST — the human-escalation "confirmed on the phone" path, PRD §6.4's fourth row; role-gated like `promote`/`verify`)
- Test: `__tests__/api/confirmations.test.ts` (testing the extracted lib logic, not the routes directly, per this session's established convention — see below)

**Design, matching the dispatch-gate.ts extraction convention:** put the real logic in `lib/confirmation-actions.ts` (new file) — `getConfirmationPageData(token)`, `submitConfirmation(token, {name, title, pdfUrl?})`, `submitDecline(token, reason)`, `recordVerbalConfirmation(token, {confirmedBy})`. Routes stay thin: validate token format, call the lib function, shape the response.

`getConfirmationPageData`: look up `pipeline_loads` by `confirmation_token`, check `confirmation_token_expires_at > NOW()` and `confirmation_outcome IS NULL` (single-use), return the agreed terms + a link to the shipper rate-con PDF (re-generate on read, or store the blob URL from Task 5's send — prefer storing it, avoid regenerating).

`submitConfirmation`: writes the **immutable `confirmation_snapshot` JSONB** per PRD §6.3 — capture the exact rate/terms *as read from the row at this moment*, plus `{name, title, timestamp, ip, userAgent}` passed in from the route (routes have access to `NextRequest` headers; the lib function takes them as plain params, doesn't reach into `NextRequest` itself, keeping it testable without a fake request object). Sets `confirmed_at`, `confirmed_rate` (from the snapshot, not re-read later), `confirmed_rate_currency`, `confirmation_outcome='confirmed'`, stage → `'shipper_confirmed'`. **This call is what enqueues Task 8's `CarrierBriefCompilerWorker`'s queue** — or does it? Re-check PRD §2: the diagram shows confirm → `shipper_confirmed` → *then* `CarrierBriefCompilerWorker` fires. Decide here: does the confirm action directly enqueue the brief-compiler queue, or does the brief-compiler worker's own queue get a job from `BaseWorker`'s stage-based dispatch (it doesn't have one — nothing polls for stage changes)? **Resolution: `submitConfirmation()` enqueues the brief-compiler queue directly**, same as `retell-webhook.ts` enqueueing `dispatchQueue`/`carrierCallQueue` on a state transition — there is no other trigger mechanism anywhere in this codebase (stage changes are never polled, always explicitly enqueued at the point they happen).

`submitDecline`: stage → `'escalated'`, `confirmation_outcome='declined'`, `decline_reason` set, write `exceptions` row (`source_module='shipper_declined'`, `severity='high'`) matching PRD §6.4.

`recordVerbalConfirmation`: same effect as `submitConfirmation` but `confirmation_outcome='escalated_verbal'`, no page-snapshot fields (no typed name/title/IP — record who-confirmed/when instead, from the operator's own auth session, matching the `verify`/`promote` routes' `user.userId` pattern). Still enqueues the brief-compiler queue — a verbal confirmation is still a confirmation, just weaker evidence, and PRD §6.4 says explicitly it must stay *distinguishable in reports*, not that it should behave differently downstream.

- [ ] Implement `lib/confirmation-actions.ts`.
- [ ] Implement the 4 thin routes.
- [ ] Tests on the lib functions directly: happy-path confirm (snapshot correct, stage flips, brief-compiler queue receives a job); expired token rejected; already-used token rejected; decline writes exceptions + escalates, no queue job; verbal-confirm path distinguishable via `confirmation_outcome`.
- [ ] `pnpm tsc --noEmit` clean, tests pass.
- [ ] Commit: `E2-04 M3: confirmation API routes + immutable snapshot`.

---

## Task 7 (M3 continued): One_pager confirm-mode

**Files (in the separate `One_pager tracking` app, NOT MyraTMS):**
- Modify: `One_pager tracking/app/track/[token]/page.tsx` — before the existing `GET /api/tracking/${token}` fetch (page.tsx:270-271), try `GET /api/confirmations/${token}` first; on 200, render confirm-mode; on 404, fall through to the existing tracking-mode fetch unchanged. This is the "one URL, two token types, two states" resolution — no change to the existing tracking-mode code path at all.
- Create: `One_pager tracking/app/track/[token]/confirm-client.tsx` (new client component, sibling to the existing `tracking-client.tsx`) — renders agreed terms, embedded PDF link, name+title inputs, Confirm/Decline buttons, decline-reason textarea, optional PDF upload control (reuses whatever upload pattern the existing app has, if any — check for one before inventing a new one).
- Modify: MyraTMS `app/api/confirmations/[token]/route.ts` response shape as needed once the client component's real data needs are known (adjust Task 6 if a field is missing — small in-place fix, not a new task).

- [ ] Implement the confirm-mode branch in `page.tsx`.
- [ ] Implement `confirm-client.tsx`.
- [ ] Wire Confirm/Decline buttons to Task 6's routes (via `NEXT_PUBLIC_API_URL`, same base-URL pattern the existing tracking fetch already uses).
- [ ] Manual smoke test: `pnpm dev` in `One_pager tracking/` against a real confirmation token seeded in dev DB, confirm the page renders and both actions round-trip. Per this repo's own testing conventions, UI work gets a real browser check, not just a type-check.
- [ ] Commit (in whichever repo tracks `One_pager tracking`'s history — confirm it's part of this same M1 git repo or a separate one before committing): `E2-04 M3: One_pager confirm-mode`.

---

## Task 8 (M5): CarrierBriefCompilerWorker

**Files:**
- Create: `lib/workers/carrier-brief-compiler-worker.ts`
- Modify: `lib/pipeline/queues.ts` (new `CARRIER_BRIEF_QUEUE_CONFIG` — this is the queue Task 6's `submitConfirmation()` enqueues into; registered in `ALL_QUEUE_CONFIGS`/`getQueuesByOrder()`)
- Possibly modify: `lib/pipeline/negotiation-brief.ts` if the existing `NegotiationBrief` type needs a carrier-flavored sibling type rather than reuse — decide during implementation by attempting reuse first (YAGNI: don't build `CarrierNegotiationBrief` as a parallel type unless the shipper-shaped one genuinely doesn't fit)
- Test: `__tests__/pipeline/carrier-brief-compiler-worker.test.ts`

**This task's last line is the actual point of the whole PRD**: on success, enqueue `carrier-call-queue` with the compiled brief — the first real producer of that queue's first job, ever, closing the gap this whole document exists to close.

Mirrors `compiler-worker.ts`'s structure exactly (per the scout's detailed structural report): `extends BaseWorker`, `expectedStage: 'shipper_confirmed'`, fetch pipeline load, fetch the ranked carrier stack (reuse whatever `carrier-cascade.ts`/`carrier-voice-worker.ts` already use to read `match_results` — don't reinvent), select a carrier persona via `selectPersona()` from `persona-selector.ts` filtered `call_type='outbound_carrier'` (Task 3's pattern, mirrored not duplicated — consider extracting a shared `selectPersonaFromDb(callType)` helper both compiler workers call, if that doesn't fight `compiler-worker.ts`'s existing structure too hard), compute the envelope via `calculateCarrierNegotiationParams(confirmed_rate, currency)` (already built, E2-03), assemble a brief with real load details + carrier company/contact + envelope + (per PRD §10) `load_source_class` from E2-01's classifier if that's a reasonably cheap read (check `lib/verification/` / E2-01's module for the exact read pattern first — if it requires a heavier lookup, note as a follow-up rather than blocking this task), persist it, compile the Retell dial payload, and set `nextStage` (or an override, matching `compiler-worker.ts`'s own `updatePipelineLoad` pattern) to enqueue `carrier-call-queue`'s first job with `cascadePosition: 0, voicemailRetryCount: 0`.

- [ ] Queue config + registration.
- [ ] Worker implementation.
- [ ] Tests: happy path (brief compiled, persisted, carrier-call-queue receives position-0 job); empty carrier stack → escalate, no dial attempt; persona selection only ever draws `call_type='outbound_carrier'` rows (regression-guards Task 3's whole point).
- [ ] `pnpm tsc --noEmit` clean, tests pass.
- [ ] Commit: `E2-04 M5: CarrierBriefCompilerWorker — the first real trigger into carrier-call-queue`.

---

## Task 9: Boot the two new workers + CarrierVoiceWorker in run-workers.ts

**Files:**
- Modify: `scripts/run-workers.ts`
- Modify: `lib/workers/index.ts` (barrel export)

Confirmed this session: `CarrierVoiceWorker` exists, is fully built, and has never been booted anywhere outside tests. This task finally does it, alongside the two new workers this plan just built. All three additions are still behind their existing kill switches (`CARRIER_CALLS_ENABLED` for the voice worker, nothing new needed for the confirmation/brief workers since they're gated by the stages they consume, which nothing reaches until Task 6/8 ship) — booting the worker does not itself enable live dialing.

- [ ] Import + instantiate `ShipperConfirmationWorker`, `CarrierBriefCompilerWorker`, `CarrierVoiceWorker` in `run-workers.ts`, matching the existing 7 workers' construction pattern exactly.
- [ ] Add to `lib/workers/index.ts` barrel + `startAllWorkers()`.
- [ ] `pnpm tsc --noEmit` clean.
- [ ] Commit: `E2-04: boot ShipperConfirmationWorker, CarrierBriefCompilerWorker, and (finally) CarrierVoiceWorker in run-workers.ts`.

---

## Task 10 (M6): Revised dispatch gate — carrier signed rate-con required

**Files:**
- Modify: `lib/dispatch-gate.ts` (`runAiCascadeDispatchGate()`)
- Test: extend `__tests__/api/dispatch-gate.test.ts`

**This revises E2-03 M3 per the PRD's explicit supersession (§9).** Today: rate-con send-attempted-and-logged is sufficient to flip `Dispatched` (this session's own M3 work). New requirement: `Dispatched` additionally waits for `carrier_ratecon_signed_at` to be set — which only happens via Task 12's IMAP poller detecting the carrier's signed reply. This means `runAiCascadeDispatchGate()` no longer flips status at the end of its own call — it sends the rate-con, sets a 90-minute signature SLA delayed job (same pattern as Task 5), and returns a new `outcome: 'awaiting_signature'` instead of `'dispatched'`. A **separate** function (call it `completeDispatchOnSignedRateCon(pipelineLoadId)`) — invoked by Task 12's poller when it classifies an inbound message as `carrier_ratecon`, verified — does the actual `status='Dispatched'` flip + tracking-token issuance + shipper notification.

90-minute SLA miss: `exceptions` row (`source_module='carrier_ratecon_unsigned'`), load stays undispatched, cascade does **not** advance to the next carrier automatically (PRD §9 — a human decides chase-vs-move-on).

- [ ] Change `runAiCascadeDispatchGate()`'s terminal state from dispatching to `awaiting_signature` + SLA timer.
- [ ] Implement `completeDispatchOnSignedRateCon()`.
- [ ] Implement the 90-min SLA-miss escalation job.
- [ ] Update existing M3 tests for the new terminal state; add tests for the signed-completion path and the SLA-miss path.
- [ ] Update PRD §11 spec-reconciliation note is already in the PRD itself — mirror it as a one-line addition to `docs/superpowers/plans/2026-08-26-e2-03-m3-m4-dispatch-gate.md`'s own header or a completion.md note, so a future reader of the M3 plan isn't misled by now-superseded text.
- [ ] `pnpm tsc --noEmit` clean, tests pass.
- [ ] Commit: `E2-04 M6: dispatch gate requires carrier signed rate-con, not send-attempted (supersedes E2-03 M3)`.

---

## Task 11: Stuck-load coverage for the 2 new stages (M7 slice)

**Files:**
- Modify: `lib/pipeline/health-checks.ts`
- Test: extend `__tests__/pipeline/health-checks.test.ts`

Per PRD §2's own callout and E2-02 §3.6 item 20's precedent (already closed once this session for `'dispatched'`) — new stages are exactly how a load disappears silently if forgotten here. `'awaiting_shipper_confirmation'` and `'shipper_confirmed'` should NOT be added to the blanket exclusion list — they're expected to move within the 45min/2h SLA windows Task 5 already enforces, so if health-checks' own 60-minute default threshold ever fires on `awaiting_shipper_confirmation`, that's a genuine second signal (the SLA escalation didn't fire, or fired and nobody acted) worth surfacing, not a false positive to suppress.

- [ ] Confirm (don't just assume) the two new stages fall through to the default 60-minute branch in `detectStuckPipelineLoads()`'s existing `NOT IN (...)` clause — they will unless explicitly excluded, so this may be a no-op requiring only a test, not a code change.
- [ ] Add tests proving both new stages ARE caught by the existing stuck-load query at the 60-minute threshold.
- [ ] `pnpm tsc --noEmit` clean, tests pass.
- [ ] Commit: `E2-04 M7: confirm stuck-load coverage reaches the 2 new stages`.

---

## Task 12 (M4): IMAP poller service

**Files:**
- Add dependency: `imapflow` (+ `mailparser` for MIME/attachment parsing if `imapflow` doesn't include it — check its own dependency tree before adding a second package)
- Create: `lib/email/imap-poller.ts` (the poll loop + message fetch)
- Create: `lib/email/inbound-classifier.ts` (sender verification + `reply_type` classification, per PRD §8)
- Create: `scripts/run-imap-poller.ts` (Railway entry point, separate process from `run-workers.ts` — or the same process if simpler; decide based on whether BullMQ's event loop and a 60s IMAP poll interval coexist cleanly in one Node process — likely yes, prefer ONE process over two Railway services unless there's a concrete reason not to)
- Modify: `scripts/run-workers.ts` if the poller joins that same process
- Modify migration 046 (Task 2) if `inbound_emails` needs an index this task discovers it's missing
- Test: `__tests__/email/inbound-classifier.test.ts` (pure logic — sender verification + classification rules are the part worth unit-testing hard; the actual IMAP connection is not something to test against a real mailbox in CI, mock the `imapflow` client)

**This is the highest-external-risk task in the whole plan** — it's the one piece needing real IONOS mailbox credentials to ever run for real (`IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD` or similar, new env vars, gated by a new kill switch e.g. `INBOUND_EMAIL_POLLING_ENABLED` defaulting `false`, matching every other E2-03/E2-04 flag's off-by-default posture). Build it fully, test the classification/verification logic hard, but it cannot be exercised end-to-end without credentials only you can provide.

Per PRD §8: poll `dispatch@` every 60s. Every touched message writes an `inbound_emails` row unconditionally (matched or not, verified or not) — silent drops are explicitly called out as how paper trails develop holes. Sender-domain verification is **mandatory before any attachment auto-attaches anywhere** — compare the sender's domain against the shipper's email on file (confirmation flow) or the carrier's contact on file (post-cascade), mismatch → `quarantined=true`, no auto-attach, Alert Center review. Classification by load stage + sender per the PRD's table (§8) — `awaiting_shipper_confirmation`/`shipper_confirmed` + shipper domain → `shipper_ratecon`; post-cascade + carrier domain → `carrier_ratecon` (this is what Task 10's `completeDispatchOnSignedRateCon()` consumes); post-dispatch + carrier domain → `pod`; anything ambiguous → `unclassified`, attached and flagged, never guessed. Dedupe on RFC `Message-ID` (unique constraint already in migration 046).

- [ ] Add `imapflow` dependency.
- [ ] Implement `inbound-classifier.ts` (pure functions: `verifySender()`, `classifyReplyType()`) — test this hardest, it's the security-relevant piece.
- [ ] Implement `imap-poller.ts` (connect, poll loop, per-message: parse, verify, classify, write `inbound_emails` row, on `carrier_ratecon` classification + verified call `completeDispatchOnSignedRateCon()`, on `shipper_ratecon`/`pod` classification + verified attach to `documents`).
- [ ] Wire the `INBOUND_EMAIL_POLLING_ENABLED` kill switch, default false.
- [ ] Entry point script + `run-workers.ts` wiring decision.
- [ ] Tests on the classifier (mocked messages, no real IMAP connection): correct classification per PRD's table; sender mismatch → quarantined, not attached; missing Message-ID or duplicate → dedupe no-op; ambiguous case → `unclassified`, flagged, not auto-attached anywhere meaningful.
- [ ] `pnpm tsc --noEmit` clean, tests pass.
- [ ] Commit: `E2-04 M4: IMAP poller — sender verification, classification, quarantine`.

---

## Task 13: Full regression + completion tracker

- [ ] `pnpm tsc --noEmit` clean across the whole repo.
- [ ] `pnpm vitest run __tests__/` full suite — confirm no new failures beyond the already-documented pre-existing ones (`ranker.test.ts`, `cost-calculator.test.ts`, and the occasional full-suite-concurrency flake already characterized this session).
- [ ] Append a completion.md entry (Engine 2's tracker) covering E2-04 in full: what shipped, what's operator-gated (Retell dashboard voice-agent prompt changes for M0's conversational half, IONOS mailbox credentials for M4, 3 new carrier Retell agents for M5 — same as E2-03's own still-open Retell items), what real findings surfaced during the build.
- [ ] Push to `origin/master`, confirm Vercel production deploy Ready (same `vercel ls`/`vercel inspect` check used earlier this session).
- [ ] Final commit + push.

---

## Self-Review Notes

- **Spec coverage:** every PRD module (M0-M7) maps to a task above; §9's gate revision explicitly cross-references and supersedes this session's own earlier E2-03 M3 work rather than silently diverging from it.
- **Deliberately flagged, not built:** the Retell-dashboard half of M0 (voice agent prompt) and M5 (3 carrier agents) — dashboard config, not code, same category as every other Retell setup item already open in the E2-03 tracker.
- **Sequencing:** Tasks 1-3 (M0/M1) are the true prerequisite layer — nothing after them can be tested meaningfully without the schema existing. Tasks 4-9 build the trigger chain in the order data actually flows. Task 10 (M6's gate revision) is placed after Task 9 deliberately — it touches `dispatch-gate.ts`, which Task 9 doesn't modify, so ordering between them is really about narrative clarity, not a hard dependency; either order works. Task 12 (IMAP poller) is placed last among the build tasks because Tasks 6 and 10 both have a real, testable path that doesn't require it (page-click confirm; a manually-invoked `completeDispatchOnSignedRateCon()` for testing) — the poller is what makes the paper-trail half automatic, not what makes the trigger chain function at all.
