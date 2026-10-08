---
title: Engine 2 Sell-Side Investigation — Booked to Scored
id: E2-02
version: 1.0
date: 2026-08-25
owner: Patrice Penda
status: current
classification: Technical — Engineering + Founder
supersedes: []
depends_on: [dispatcher-worker.ts, voice-worker.ts, ranker-worker.ts, compiler-worker.ts,
  feedback-worker.ts, retell-webhook.ts, retell-types.ts, cron-handlers.ts, gate.ts,
  stages.ts, queues.ts, payloads.ts, types.ts, myra_negotiation_brief_schema.ts (negotiation-brief.ts),
  compliance-service.ts, claude-service.ts, cost-calculator.ts, service-token.ts,
  lib/matching/index.ts, lib/matching/filters.ts, lib/matching/scoring/reliability.ts,
  app/api/loads/route.ts, "app/api/loads/[id]/route.ts", "app/api/loads/[id]/assign/route.ts",
  "app/api/loads/[id]/tracking-token/route.ts", "app/api/loads/[id]/send-tracking/route.ts",
  app/api/matching/refresh-lanes/route.ts, app/api/cron/pipeline-health/route.ts,
  pipeline_migrations.sql, 014-carrier-matching-engine.sql, 023-pipeline-schema-corrections.sql,
  024-pipeline-brief-schema-corrections.sql, 025-compliance-audit-table.sql,
  026-loadboard-sources.sql, 027_multi_tenant_foundation.sql, 028_add_tenant_id.sql,
  029_create_rls_policies.sql, 030_engine2_tenanting.sql.PENDING, 031_tenant_usage.sql,
  032-carrier-status-prospect.sql, T07_Carrier_Ranker.md, T09_Voice_Agent_Retell.md,
  T10_Dispatcher_Agent.md, T12_Call_Parser.md, T13_Compliance_Consent.md,
  T20_Carrier_Intelligence.md, T22_Negotiation_Service.md, T23_Dispatch_Lifecycle_Monitor.md,
  T25_Risk_Fraud.md, E2-01_Engine2_Expansion_PRD.md, retell_config_carrier_onboarding.jsx,
  retell_config_v2_gatekeeper.jsx]
referenced_by: []
note: |
  Audit only. No source files were modified, created, or deleted in the course
  of this investigation; this report is the sole output. It feeds a forthcoming
  E2-02 PRD build session and follows the E2-01 authoring pattern (§0-style
  codebase audit before any build).

  Terminology mapping (read once, applies throughout): the codebase and
  T-series specs use brokerage convention — sell side = shipper, buy side =
  carrier (T-22 §1, E3-00 §4.2, "dispatch_one_v1.json" as a buy-side agent
  concept). This report uses the founder's inverted framing instead: "buy
  side" = acquiring the load (scan → qualify → research → shipper call →
  booked; covered by E2-01). "Sell side" = moving the booked load (booked →
  dispatch → pick carrier → call carrier(s) → negotiate carrier rate → rate
  con → assign → track → deliver → score; covered here). Every place this
  report says "carrier call," "carrier negotiation," or "sell side," a cited
  spec or code comment may instead say "buy-side agent," "Dispatch One," or
  "carrier-side booking." They are the same concept. This note is not
  repeated below.
---

# E2-02 — ENGINE 2 SELL-SIDE INVESTIGATION
## What Happens Between "Booked" and "Scored"

| Field | Value |
|---|---|
| Document | E2-02 (sell-side audit) |
| Version | 1.0 |
| Date | 2026-08-25 |
| Owner | Patrice Penda, Founder |
| Status | Current — audit complete, feeds forthcoming PRD |
| Method | 4 parallel deep-read investigations across `MyraTMS/lib/pipeline`, `lib/workers`, `lib/matching`, `lib/cron`, `app/api/loads/*`, migrations 014/023-035, and 9 T-series specs, cross-verified by direct reads of `dispatcher-worker.ts` (full, 339 lines) and `queues.ts` |
| Verdict (one line) | **A booked load reaches "carrier assigned, tracking link sent, stage=dispatched" with zero human action and zero carrier contact.** No carrier is ever called, negotiated with, or asked to confirm. |

---

## 1. One-screen summary

Today, the moment a shipper-call transcript parses to `outcome='booked'` with recomputed profit ≥ `brief.rates.minMargin`, the load is enqueued to `dispatch-queue` with **no human step** (`retell-webhook.ts:820-864, 968-981`). The Dispatcher (Agent 7) reads a single `top_carrier_id` off `pipeline_loads` — whatever the Ranker wrote at qualification time, possibly hours stale — checks one binary gate (`carriers.carrier_status = 'active'`, else escalate to a human), and if it passes, **calls `POST /api/loads/[id]/assign` directly** (`dispatcher-worker.ts:89-165, 254-273`). **No carrier is ever called.** `voice-worker.ts`, the pipeline's only call-placing worker, is wired exclusively to the shipper flow (`expectedStage: 'briefed'`, hardcoded `call_type='outbound_shipper'`); there is no carrier-call queue among the pipeline's 9 queues, no carrier Retell agent-id selection logic, and `dispatch_one_v1.json` — named in this investigation's own scope as something to read — **does not exist anywhere in the repository.** The carrier "rate" written into the TMS margin calculation is not a negotiated number; it's the Ranker's historical-average scoring artifact (`match_results.breakdown.rate.carrier_avg_rate`), which silently defaults to `$0` (100% margin) when a carrier has no rate history. A rate-confirmation PDF is generated and attached, but the carrier-facing send step is a `console.log` stub — nothing reaches the carrier. Stage flips to `dispatched` immediately, unconditionally. Post-dispatch, the only lifecycle monitoring is a delivered-status advancer keyed off the TMS's own `loads.status`; no no-show, late-pickup, missing-check-call, or fall-off detection exists. All four downstream specs that would fix this (T-20, T-22, T-23, T-25) are unbuilt, `status: draft`, Engine 3 Phase 2 (not started), and each independently states this same gap in its own text after reading the same code. **Plainly: yes, a booked load can reach "carrier committed" with zero human action today — but there is no real carrier commitment behind it, because the carrier is never contacted.**

---

## 2. Stage-by-stage trace — one hypothetical booked load

LIVE = runs in production today · SHADOW = code exists but is gated to no-op by an env flag · STUB = code exists, does not perform the real action (e.g. logs instead of sending) · NOT FOUND = no code exists for this step.

| # | Step | File:line | Status |
|---|---|---|---|
| 1 | Shipper call transcript parsed; `profit = final_rate − totalCost` recomputed server-side; `auto_book_eligible = profit ≥ brief.rates.minMargin` | `lib/pipeline/retell-webhook.ts:352-374` (using shipper's `CALL_PARSER_SYSTEM_PROMPT`, `lib/pipeline/claude-service.ts:245`) | LIVE |
| 2 | `agent_calls` row written, `call_type='outbound_shipper'` (only literal value ever written anywhere in the file) | `retell-webhook.ts:701-798`, esp. 715 | LIVE |
| 3 | `pipeline_loads.stage → 'booked'` (or `'escalated'` if under margin — the only human-in-the-loop branch, and it's a margin check, not a carrier-readiness check) | `retell-webhook.ts:820-864` | LIVE |
| 4 | Enqueue `dispatch-queue` job (`DispatchJobPayload`: `pipelineLoadId, agreedRate, agreedRateCurrency, profit, callId` — no `carrierId`) | `retell-webhook.ts:967-981` | LIVE |
| 5 | **Carrier called to negotiate/confirm** | — | **NOT FOUND** — no queue, no worker, no Retell agent-id resolution for a carrier call exists anywhere in `lib/pipeline` or `lib/workers` |
| 6 | **Webhook receives a carrier-call event** | — | **NOT FOUND** |
| 7 | **Carrier outcome parsed (accept / decline / voicemail)** | — | **NOT FOUND** |
| 8 | **Cascade to carrier #2 on decline/no-answer** | — | **NOT FOUND** — the code only ever reads one `top_carrier_id` value, never a ranked stack |
| 9 | Dispatcher picks up `dispatch-queue`; `expectedStage: 'booked'` validated by `BaseWorker` | `lib/workers/dispatcher-worker.ts:69-87`; `lib/workers/base-worker.ts` | LIVE |
| 10 | Read `pipeline_loads.top_carrier_id` (single value, frozen at Ranker/qualification time — not recomputed) | `dispatcher-worker.ts:93-97, 167-176` | LIVE, but reading stale/pre-existing data, not a fresh selection |
| 11 | Prospect gate: `carriers.carrier_status ≠ 'active'` → `stage='escalated'`, human review | `dispatcher-worker.ts:99-118, 186-201` | LIVE — the one real safety valve on this path |
| 12 | Read `carrierRate` from `match_results.breakdown.rate.carrier_avg_rate` (Ranker's historical-average scoring input, not a negotiated figure; falls back to `0`) | `dispatcher-worker.ts:120, 203-212` | LIVE, feeding a scoring artifact into the margin calc |
| 13 | `POST /api/loads` — creates TMS load row, `revenue = agreedRate` (the shipper's real, voice-confirmed number), `carrierCost: 0` placeholder | `dispatcher-worker.ts:124-125, 214-252`; `app/api/loads/route.ts:55-103` | LIVE |
| 14 | Direct DB patch: `pipeline_load_id`, `source_type='ai_agent'`, `booked_via='ai_auto'` | `dispatcher-worker.ts:127-136` | LIVE |
| 15 | `POST /api/loads/[id]/assign` — writes `carrier_id = top_carrier_id` unconditionally, `assignment_method: 'ai_auto'`, computes margin from the step-12 estimate, generates a rate-con PDF, flips `loads.status → 'Dispatched'` | `dispatcher-worker.ts:138-139, 254-273`; `app/api/loads/[id]/assign/route.ts:19-105` | LIVE (assign, margin write, PDF generation) |
| 16 | Rate-con auto-send to carrier | `app/api/loads/[id]/assign/route.ts:107-123` | **STUB** — reads `settings.auto_send_rate_con`, looks up carrier contact, `console.log`s it. No email/fax/SMS is sent. |
| 17 | `POST /api/loads/[id]/tracking-token` + `/send-tracking` — shipper only, best-effort (`if (load.shipper_email)`) | `dispatcher-worker.ts:141-146, 275-292`; `tracking-token/route.ts`; `send-tracking/route.ts` | LIVE (shipper-facing only) |
| 18 | `pipeline_loads.stage → 'dispatched'`, `tms_load_id` written | `dispatcher-worker.ts:298-315` | LIVE |
| 19 | Driver assignment / Driver PWA (DApp) handoff | — | **NOT FOUND** on the AI path — the Dispatcher never sends `driver_id`; `assign/route.ts`'s driver-assignment branch is dead code on this path |
| 20 | Post-dispatch lifecycle monitoring: no-show, late pickup, missing check-call, carrier fall-off | — | **NOT FOUND** — `lib/cron/cron-handlers.ts` (969 lines, would-be lifecycle scheduler) is dead code, not wired to any live Vercel cron route |
| 21 | Delivered-status advancement: `pipeline_loads.stage → 'delivered'` when linked `loads.status = 'Delivered'` | `dispatcher-worker.ts:323-339` (`advanceDeliveredLoads`), called from `app/api/cron/pipeline-health/route.ts` | LIVE — the only real post-dispatch automation, and it depends entirely on an externally-set TMS status, not on any independent verification |
| 22 | Stuck-load detector | `app/api/cron/pipeline-health/route.ts:51-58` | LIVE, but its `WHERE stage NOT IN (...,'dispatched',...)` clause **excludes `dispatched` by construction** — a load stuck at `dispatched` for days is invisible to it |
| 23 | Feedback worker: persona stats, rate accuracy, lane stats | `lib/workers/feedback-worker.ts:63-393`, fires once at `expectedStage: 'delivered'` | LIVE, but reads whichever `agent_calls` row is chronologically most recent for the load (line 135-139) — no shipper/carrier discriminator column found, and since no carrier call exists today this is moot in practice |
| 24 | `pipeline_loads.stage → 'scored'` | Implied terminal stage per `stages.ts`; not independently re-verified in this pass since Feedback worker's own stage-write line was outside the read window supplied — treat as LIVE by convention with the rest of the Feedback worker, not separately confirmed | LIVE (unconfirmed exact line) |

---

## 3. Checklist answers (§3, items 1–26)

### §3.1 Entry into the sell side

**1. What exactly happens on `outcome='booked'`? Which queue, payload, stage write? Human confirmation step?**

`retell-webhook.ts:820-825` (`determinePipelineStage()`):
```
case 'booked':
  stage = result.auto_book_eligible ? 'booked' : 'escalated';
```
`auto_book_eligible` is a pure server-side math gate computed at `retell-webhook.ts:359-374`: `callResult.profit = callResult.final_rate - totalCost; ...auto_book_eligible = callResult.profit >= minMargin`. If true, `enqueueNextAction()` (`retell-webhook.ts:967-981`) enqueues a `DispatchJobPayload` to `dispatch-queue` immediately. **There is no human confirmation step between shipper-booked and dispatch-queue.** The only human-in-the-loop branch is the `else` — profit below `minMargin` routes to `escalation-queue` — which is a margin check, not a carrier-readiness or booking-legitimacy check. Grepped for every other write of `stage = 'booked'` across `lib/`: this is the single hit.

**2. Is there a path where a load enters the sell side without a shipper voice call? Does it carry `load_source_class`?**

**NOT FOUND.** No other code path writes `pipeline_loads.stage = 'booked'`. CSV import and manual TMS load creation can create rows, but nothing moves a `pipeline_loads` row to `booked` except `processCallCompleted()` parsing a real Retell transcript. `load_source_class` — the E2-01-proposed column for exactly this classification — **does not exist in any live migration or code file.** Its only occurrence in the repo is `MyraTMS/docs/superpowers/specs/2026-08-24-e2-01-m1-session1-design.md`, a design doc, not shipped schema or code.

### §3.2 Carrier selection

**3. Where is the carrier stack for a booked load actually read from?**

`dispatcher-worker.ts:167-176` (`fetchPipelineLoad`) selects `top_carrier_id` straight off `pipeline_loads`. This is **whatever the Ranker (Agent 4) wrote once, at qualification time** — `ranker-worker.ts` is bound to `match-queue`, `expectedStage: 'qualified'`, fires exactly once per load in parallel with the Researcher (`ranker-worker.ts:67-74`), and persists only `carrier_match_count` + `top_carrier_id` onto `pipeline_loads` (`ranker-worker.ts:229-236`) — the full ranked stack with scores lives only in the audit table `match_results` (`storeMatchResults()`, line 145) and in-memory for the brief-compilation gate. `dispatcher-worker.ts` never imports or calls `matchCarriers()` — confirmed by full read of the file (no `lib/matching` import anywhere in its 339 lines). Given the stage machine requires `qualified → matched → briefed → calling → booked → dispatched`, each transition taking real wall-clock time, **the carrier used at dispatch can be arbitrarily stale relative to when it was ranked** — no re-check of equipment, insurance expiry, or a newly-added exclusion happens.

**4. What filters does `matchCarriers()` apply? Quote the predicate.**

`lib/matching/filters.ts:34-53` (`getEligibleCarriers`):
```sql
SELECT DISTINCT c.id, c.company, c.mc_number, c.dot_number, ...
FROM carriers c
LEFT JOIN carrier_equipment ce ON c.id = ce.carrier_id
WHERE c.authority_status = 'Active'
  AND (c.insurance_expiry IS NULL OR c.insurance_expiry > CURRENT_DATE)
  AND ( ce.equipment_type = $1
        OR c.id IN (SELECT DISTINCT carrier_id FROM loads WHERE equipment ILIKE $2 AND carrier_id IS NOT NULL) )
ORDER BY c.company
```
plus an in-memory exclusion-list filter (`filters.ts:57-58`). Hard filters: `authority_status = 'Active'` (a manually-set flag — E2-01 §0.1 independently confirms "nothing populates it from an external source"), insurance not expired, equipment match. **No home-base proximity hard filter** — proximity is a scored component (25% weight), not a filter. **`authority_status` (used here) and `carrier_status` (used by the Dispatcher's prospect gate, item 6 below) are two different, easily-confused columns on the same `carriers` table.**

**5. Is there a carrier verification gate before a carrier is called or assigned ("Gate 2")?**

**NOT FOUND as a pre-call gate** (moot — no carrier call exists to gate) **and NOT FOUND as a pre-assignment gate either**, beyond the coarse prospect/active flag (item 6). Grepped `verified_at`/`verified_by` across `lib/matching`, `lib/workers`, `lib/pipeline`: zero hits. E2-01 §0.1 independently confirms platform-wide: *"There is no FMCSA, SAFER, QCMobile, CVOR, or NSC lookup client anywhere in the codebase."* Pilot 1's promise to Kevin — "Gate 2: every carrier is human-verified before any document is issued" — has no enforcement anywhere: `assign/route.ts` generates the rate-con PDF (item 17) with no verification precondition checked.

**6. What is the "prospect gate"? Does it exist? What defines "never contacted"?**

**EXISTS — the one real safety gate on this whole path.** `dispatcher-worker.ts:99-118`:
```
// Prospect gate: the Ranker matches both 'prospect' and 'active' carriers
// so shadow drains exercise the full pipeline, but real dispatch requires
// 'active'. Carriers backfilled from FMCSA registries default to 'prospect'
// and are promoted via PATCH /api/carriers/[id]/promote after human review.
const carrierStatus = await this.fetchCarrierStatus(load.top_carrier_id);
if (carrierStatus !== 'active') {
  await this.escalateProspect(pipelineLoadId, load.top_carrier_id, carrierStatus, callId);
  return { success: true, pipelineLoadId, stage: 'escalated', ... };
}
```
`fetchCarrierStatus` (line 178-184): `SELECT carrier_status FROM carriers WHERE id = $1`. Migration `032-carrier-status-prospect.sql` adds this column (`CHECK IN ('prospect','active')`, `DEFAULT 'active'` for existing rows, `'prospect'` for FMCSA-seeded rows). **"Never contacted" is defined purely by this static column — not by any query against `agent_calls` or call history.** A carrier flipped to `'active'` by a human without ever being called passes; conversely nothing in this gate would distinguish a carrier who was actually spoken to (since no carrier-call history is ever checked).

### §3.3 Carrier calling — the "Dispatch One" agent

**7. Which worker places the carrier call? Retell `agent_id` selection logic?**

**NOT FOUND.** `voice-worker.ts` is the only call-placing worker in `lib/workers/` (confirmed by grepping the directory for `retell|agent_id|placeCall`), and it is wired exclusively to the shipper flow: `queueName: 'call-queue'`, `expectedStage: 'briefed'`, `nextStage: 'calling'` (`voice-worker.ts:59-67`), every `agent_calls` row it writes hardcodes `call_type='outbound_shipper'` (`voice-worker.ts:265`). `dispatcher-worker.ts` never calls Retell and never enqueues to `call-queue`. **`dispatch_one_v1.json`, named in this investigation's own required-reading list, does not exist anywhere in the repository** — confirmed via `Glob **/dispatch_one*` returning zero results repo-wide. It is referenced only as a design-concept name inside T18/T21/T22/T23 spec prose, never as a file, an import, or a config.

**8. What brief/payload does the carrier call receive? Map `retell_llm_dynamic_variables` keys.**

**N/A / NOT FOUND** — there is no carrier call to receive a payload. `negotiation-brief.ts` and `compiler-worker.ts` build exactly one payload shape, and it is shipper-facing: the `carriers` field in the brief (`compiler-worker.ts:173`) is *informational content the shipper agent references* (e.g., "we have vetted carriers on this lane," confirmed against `fixtures/retell-payload.json:53`'s `selling_points` string), not a payload transmitted to a carrier.

**9. What is the carrier-side negotiation envelope (max/target/walk-away)? Margin floor enforced in code or only prompt?**

**NOT FOUND.** `cost-calculator.ts`'s only negotiation-envelope function is `calculateNegotiationParams(totalCost, currency, marketRateBest)` (`cost-calculator.ts:562-616`), documented as a helper "for Agent 3 (Research) to build the rate cascade" — it computes what Myra offers the **shipper**, working up from Myra's own cost. Nothing in the file takes an agreed shipper rate and derives a carrier-pay ceiling beneath it. No margin floor is enforced in code on a carrier leg, because no carrier leg is computed anywhere.

**10. The cascade — carrier declines, unreachable, or voicemails. Exact branch.**

**NOT FOUND — this is not a code gap so much as an absent capability.** `dispatcher-worker.ts:89-165` has exactly two branches after fetching `top_carrier_id`: (a) not `'active'` → escalate to human (item 6); (b) `'active'` → `assignCarrier()` unconditionally (line 139, 254-273), a single `POST /api/loads/[id]/assign` call. **There is no retry-to-next-carrier loop, no re-rank, no fallback.** The code only ever reads a single `top_carrier_id` value — never a ranked list — so "carrier 1 declines" is not a state the code can represent. If `/assign` itself returns non-2xx, the worker throws (line 269-271), and BullMQ retries the **whole `dispatch-queue` job** per its `retryConfig` (`dispatcher-worker.ts:76-79`: 3 attempts, exponential backoff, 60s initial) — but a retry re-runs `process()` from the top, **re-attempting the same carrier**, not advancing to a different one.

> **Bug found independently in this pass, not flagged by name in any prior spec:** because `process()` (`dispatcher-worker.ts:89-165`) is one un-checkpointed function covering `POST /api/loads` (step 13) *through* `assignCarrier()` (step 15) with **no idempotency check before creating the TMS load row**, a retry triggered by a failure at step 15 (assign) or step 16/17 (tracking) re-runs `createTMSLoad()` from scratch — **creating a second, duplicate `loads` row for the same `pipeline_loads` entry** on every retry. See §4, severity: high.

**11. Concurrency — can two carriers be called for the same load at once? Lock model?**

Moot given item 7 (no carrier call exists), but the underlying primitives are real and relevant to any future carrier-calling worker: `MAX_CONCURRENT_CALLS` is a **global** cap, not per-load or per-carrier — `voice-worker.ts:194-199` (`countActiveCalls`) does `SELECT COUNT(*) FROM pipeline_loads WHERE stage = 'calling'`, a system-wide count. **No per-load DB lock, no `FOR UPDATE`, no Postgres advisory lock, and no Redis lock key exist anywhere in `lib/`** (grepped `MAX_CONCURRENT_CALLS|advisory_lock|pg_advisory|FOR UPDATE`). The only thing preventing a double-call on the shipper side is stage-based idempotency (`expectedStage: 'briefed'` combined with the worker itself flipping the row to `'calling'` in the same job) — racy under true concurrency, not a lock. A future carrier-calling worker reusing this pattern would inherit the same race.

**12. Calling hours, DNC, consent model for carriers — is `compliance-service.ts` actually run? Is `dnc_list` consulted for carrier phones?**

**Split finding: the purpose-built compliance service is dead code; a cruder inline reimplementation runs instead — and it is only ever invoked for shipper calls.** `compliance-service.ts:269-282` does define a `carrier_recruitment` consent basis with implied consent ("Carrier has public business listing") inside `checkConsentStatus()`, itself gated by the master function `runFullComplianceCheck()` (lines 70-90, `dncCheck` + `consentCheck`). **But `ComplianceService`/`createComplianceService()` is never instantiated anywhere outside `compliance-service.ts` itself** — grepped every `.ts` file in the repo; the only hits are the class definition, its own factory, and one doc-comment mention elsewhere. **`runFullComplianceCheck()` has no caller. It is dead code.** What actually runs pre-dial is `voice-worker.ts`'s own from-scratch `recheckCompliance()` (lines 161-181): a generic `SELECT id FROM dnc_list WHERE phone = $1` plus an 8am–8pm local-hours check, with **no `callType` parameter** and no consent-basis distinction at all — and since `voice-worker.ts` only ever fires for shipper calls (`expectedStage: 'briefed'`, item 7), this check never runs against a carrier phone today either.

**13. Retries — voice-worker.ts has none by design. On the carrier path, what distinguishes "retry later" from "carrier said no"?**

**N/A / NOT FOUND** — there is no carrier path to distinguish outcomes on. The only retry behavior that exists in this vicinity is the `dispatch-queue`'s standard 3-attempt exponential backoff on the whole `process()` function (item 10's bug finding) — which has no concept of a carrier response at all, since no carrier is ever contacted.

### §3.4 Webhook and outcome handling on carrier calls

**14. How does the webhook know a call was a carrier call vs. a shipper call? Where does `agreed_rate` for the carrier go?**

**Moot today (no carrier call exists), but the shared-column risk is real by construction.** `retell-webhook.ts` has exactly one outcome vocabulary and one write path: `processCallCompleted()` parses every transcript through the same shipper-framed logic and writes the result into `pipeline_loads.agreed_rate` (line 854) and `pipeline_loads.profit` (line 856) — the same columns regardless of call origin, because only one origin (`outbound_shipper`) has ever existed. **If a future carrier-calling worker reused this handler without adding a `call_type` branch, it would silently overwrite the shipper's `agreed_rate`/`profit` with the carrier's numbers, or vice versa** — flagged in §4 as a live-path risk even though it cannot fire under the current, single-origin code.

**15. Is `parseCallOutcome`/`CALL_PARSER_SYSTEM_PROMPT` shipper-specific? Is there a carrier-transcript parser?**

**Confirmed shipper-only; no carrier variant exists.** `CALL_PARSER_SYSTEM_PROMPT` (`claude-service.ts:245`) opens: *"You are an expert freight brokerage call analyst. Your job is to analyze call transcripts between an AI freight broker agent and a shipper, and extract structured data."* — "shipper" is hardcoded into the system prompt itself. `parseCall()` (`retell-webhook.ts:352-357`) calls this with no override. Grepped `claude-service.ts` for other `_SYSTEM_PROMPT` constants: only one exists.

### §3.5 Rate confirmation, assignment, tracking

**16. Which carrier does `/assign` receive — the one that accepted on the call, or `top_carrier_id`?**

**`top_carrier_id`, unconditionally** (`dispatcher-worker.ts:139, 254-273`) — there is no "carrier that accepted" because no carrier is ever called. `assignment_method: 'ai_auto'` is a hardcoded literal, not derived from any carrier-side confirmation.

**17. Is a rate confirmation document generated and sent? What fields? Signed-before-dispatch check?**

**EXISTS with no signature gate and no real send.** `app/api/loads/[id]/assign/route.ts:90-105` calls `generateRateCon()`, uploads the PDF to Vercel Blob, and attaches it as a `Document` — all inside the same `/assign` call, built from the unverified `top_carrier_id` + the Ranker-average `carrierRate` (item 3/18), not a confirmed carrier agreement. Generation is wrapped in try/catch (lines 124-126, "assignment still successful" on failure) — **assignment succeeds even if PDF generation fails, so "rate con sent" is not a precondition of "carrier assigned."** The auto-send hook (lines 107-123) is a **STUB**: it reads `settings.auto_send_rate_con`, looks up the carrier's contact, and `console.log`s it — no email/fax/SMS is sent to the carrier under any code path found. `loads.status` flips to `'Dispatched'` (line 42, `CASE WHEN status = 'Booked' THEN 'Dispatched'`) in the same `UPDATE` that writes `carrier_id`, **before the rate-con block even executes** — there is no signed-document precondition anywhere.

**18. What writes `carrier_rate`/carrier cost and computes final profit — call outcome, assign route, or Researcher placeholder?**

**A fourth thing: the Ranker's scoring-time average, read fresh at dispatch, then written by the assign route.** Chain: `dispatcher-worker.ts:120` → `fetchCarrierRate()` (203-212) reads `match_results.breakdown.rate.carrier_avg_rate` — the Ranker's rate-scoring input (`lib/matching/index.ts:169-172`), **not a negotiated or confirmed rate** — passed to `/assign` as `carrier_rate` → `assign/route.ts:33-36`: `carrierCost = carrier_rate || 0; margin = revenue - carrierCost`. Written to `loads.carrier_cost`, `loads.margin`, `loads.margin_percent`. **This is a live-path gap**: revenue (`agreedRate`) is a real, voice-confirmed shipper number; cost is a statistical guess frozen at ranking time. If `carrierAvgRate` is null/zero (new carrier, no history), `fetchCarrierRate` falls back to `0` (line 211) — **`carrierCost = 0`, `margin = revenue`: a load can show 100% margin purely because the carrier had no rate history, with no flag distinguishing this from a genuine zero-cost load.**

**19. Does the AI path end at carrier assignment, or does it also assign a driver / trigger the Driver PWA?**

**Ends at carrier assignment.** `assignCarrier()` (`dispatcher-worker.ts:254-273`) sends only `{ carrier_id, carrier_rate, assignment_method }` — no `driver_id`. `assign/route.ts` does have a driver-assignment branch (would flip `drivers.status='on_load'`) if `driver_id` is present in the request body, but the Dispatcher never sends one, so it's dead on this path. Tracking-link generation (`sendTrackingLink`, lines 275-292) is shipper-only (`load.shipper_email`, best-effort). **No driver assignment, no DApp trigger, from the AI dispatch path** — getting a load into the Driver PWA's queue requires a separate, human-triggered TMS action.

### §3.6 Lifecycle monitoring and feedback

**20. What watches a dispatched load? Compare to T-23's scope: EXISTS / PARTIAL / NOT FOUND per capability.**

**`lib/cron/cron-handlers.ts` (969 lines, a would-be `setInterval`-based scheduler with a `pollSourceForLoads()` that is a literal stub returning zeros) is dead code — not wired to any live Vercel cron route.** The actual live `/api/cron/pipeline-health` route (71 lines, standalone) does two things: `advanceDeliveredLoads()` (item 21) and a stuck-load query that **explicitly excludes `dispatched`** from its `NOT IN (...)` clause (`pipeline-health/route.ts:51-58`) — a load stuck at `dispatched` for days is invisible to it by construction.

| T-23 capability (`Engine 2/T23_Dispatch_Lifecycle_Monitor.md`) | Status | Evidence |
|---|---|---|
| Event taxonomy extension (`carrier_assigned`, `carrier_acceptance_confirmed`, `pickup_checked_in`, `late_detected`, etc.) | NOT FOUND | T-23 unbuilt (`status: draft`, Engine 3 Phase 2, not started per `Engine 3/docs/superpowers/plans/completion.md`) |
| `carrier_acceptance_state` table | NOT FOUND | Not in migrations 023-035; proposed DDL only |
| Acceptance-gap measurement script | NOT FOUND | Deliverable of an unbuilt spec |
| `dispatch_routing_rules` | NOT FOUND | Proposed DDL only, also gated on T-19 (not started) |
| `v_lifecycle_late_loads` view | NOT FOUND as a view. PARTIAL crude equivalent: the stuck-load query above — but it excludes `dispatched`, so it doesn't even cover T-23's late-pickup/late-delivery use case |
| 5 read API endpoints (`/api/lifecycle/*`) | NOT FOUND | No such routes exist |
| Delivered-status advancement | **EXISTS** | `dispatcher-worker.ts:323-339`, called from `pipeline-health/route.ts` |

T-23's own author, after reading the live code, states the exact gap this investigation independently confirms (`T23_Dispatch_Lifecycle_Monitor.md:22-26`, quoted verbatim): *"`assignCarrier()` calls `/api/loads/[id]/assign`, sends a rate confirmation PDF, and immediately marks the pipeline stage `dispatched` — there is no step that waits for or records the carrier actually confirming they'll run the load. Assignment and acceptance are treated as the same event. They aren't."*

**Bottom line: EXISTS = delivered-status advancement only. Everything else in T-23's scope (no-show, late pickup, missing check-call, fall-off) is NOT FOUND.**

**21. Does the Feedback worker learn anything carrier-side, or is `updatePersonaStats` shipper-only?**

**Architecturally direction-agnostic, not explicitly shipper-only — but every carrier-specific metric asked about is NOT FOUND as a distinct computation.** `FeedbackWorker.process()` (`feedback-worker.ts:63-116`) fires once per load at `expectedStage: 'delivered'`, and `gatherContext()` (121-164) pulls context from **the most recent row in `agent_calls`** for that load (`ORDER BY call_initiated_at DESC LIMIT 1`) with **no shipper/carrier discriminator anywhere in this file**. `updatePersonaBayesian()` (171-198) increments a single shared `personas` table with no split by call direction. `upsertShipperPreferences()` (200-231) is explicitly shipper-side (`shipper_preferences`, keyed by `shipperPhone`) — **no symmetric carrier-preferences upsert exists.** Carrier acceptance rate and rate-accuracy-vs-carrier are **NOT FOUND** as computed metrics; the only rate-accuracy metric (lines 90-93) is generic predicted-vs-agreed, not carrier-specific.

**22. Do `lane_stats`/`shipper_preferences` have carrier equivalents? What updates them?**

`carrier_lanes` **exists** (`014-carrier-matching-engine.sql:22-39`, `avg_carrier_rate`, `on_time_rate`, tenant-scoped via migration 028). **What updates it is not the Feedback worker.** Two paths: (a) `POST /api/matching/refresh-lanes` — a manual, on-demand endpoint recomputing from the TMS `loads` table over a trailing-365-day window, **no cron trigger found**, so it only updates when a human or external caller hits it; (b) `scripts/seed-carriers-from-fmcsa.ts` — seed-only placeholder values (`on_time_rate=0.92`), with a comment claiming "Feedback Agent overwrites... from real data" that **is aspirational — no Feedback-worker code was found that writes to `carrier_lanes`.** Readers: `qualifier-worker.ts:232` and `lib/matching/scoring/reliability.ts:24,48` (defaults to `0.5` if absent). **Gap: `carrier_lanes.on_time_rate` is never updated by an actual AI-pipeline delivery outcome automatically** — only by a manual endpoint with no scheduling found.

### §3.7 Kill switches and shadow mode on the sell side

**23. Which env flags gate carrier calls specifically? Can shipper run live while carrier runs shadow, or is it one switch?**

**No carrier-specific kill switch exists — it is one switch, if a carrier-calling path existed at all.** Grepped every kill-switch pattern in `lib/`: `PIPELINE_ENABLED` gates all of `voice-worker.ts` (line 95-96) plus cron-level enablement (`cron-handlers.ts:997`, itself dead code); `MAX_CONCURRENT_CALLS` gates `voice-worker.ts` shadow mode (100-103) with the same shadow-mode comment threaded through `compiler-worker.ts:120-124` and `negotiation-brief.ts:700`. **`voice-worker.ts` contains zero references to "carrier" anywhere in the file** — no carrier-specific branch, no `CARRIER_CALLS_ENABLED`, `BUY_SIDE_ENABLED`, or `DISPATCH_ONE_ENABLED` exists anywhere in `lib/` or `app/`. If a carrier-calling path is ever added to this worker, it would share `PIPELINE_ENABLED`/`MAX_CONCURRENT_CALLS` undifferentiated with the shipper path — there is no way today to run shipper calls live while holding carrier calls in shadow.

**24. What does `AUTO_BOOK_PROFIT_THRESHOLD` actually gate — shipper booking, carrier assignment, or dispatch write?**

**Nothing, currently — it is dead as of Engine 3's T-19 work (dated the same day as this report).** `MyraTMS/.env.example:72`: *"# AUTO_BOOK_PROFIT_THRESHOLD removed (T-19): never read by any decision path."* Both `tenant_config.auto_book_profit_threshold_cad` and the env var were confirmed removed/superseded by T-18's per-agent governance envelope (`voice` agent's `policies.auto_book_profit_threshold_cad`, per `T18_Agent_Runtime_Governance.md:229`). **However it is still referenced in live, unrevised operator tooling**: `scripts/run-workers.ts:92`, `scripts/sprint6-shadow/01-preflight.ts:53,73`, `scripts/sprint6-shadow/05-live-call-preflight.ts:77-81`, and the runbook `README.md:44,136` — an operator following the Sprint 6 shadow-drain playbook today would set a variable the system no longer consults, believing it disables auto-booking, when the actual gate has moved to T-18's governance envelope (whose value for this pipeline was not independently verified in this pass). Flagged in §4.

### §3.8 Spec-vs-code drift

**25. T-10, T-22, T-23, T-20: capability / status / evidence.**

| Spec | Claimed capability | Status | Evidence |
|---|---|---|---|
| T-10 (§2, shipped Engine 2 spec, not draft) | Dispatcher assigns `top_carrier_id` directly from the brief, no carrier-negotiation call | **EXISTS — matches live code** | `T10_Dispatcher_Agent.md:41-47` never describes a carrier call; `dispatcher-worker.ts:95,103-120,139` mirrors it exactly |
| T-10 §4 | `assignWithFallback()` — loop to next carrier on assignment failure | **NOT FOUND / CONTRADICTED** | Spec pseudocode at `T10_Dispatcher_Agent.md:168-180`; live `dispatcher-worker.ts` has a single `assignCarrier()` call (line 139), confirmed by full read — no loop |
| T-10 §3 | `AUTO_BOOK_PROFIT_THRESHOLD` phased decision tree | **CONTRADICTED** | Item 24 above — env var is dead, not wired to any decision path |
| T-22 §1, §3.1 | "Dispatch One" (buy-side carrier-calling Retell agent) is connected to the Engine 2 orchestrator | **NOT FOUND — and the spec itself admits this was never confirmed** | T-22's own acceptance criterion 6 (line 184): *"the actual code path connecting Dispatch One to the Engine 2 orchestrator is located, documented, and confirmed... before any change is proposed to it"* — written as an open task, not a confirmed fact. Combined with `dispatch_one_v1.json` being absent repo-wide and `dispatcher-worker.ts` placing no calls, the weight of evidence is that Dispatch One is at most a Retell-dashboard-only artifact, never wired to a worker |
| T-22 §4.2 | `objection_playbook` DB table, carrier-tagged | **NOT FOUND** | Absent from all migrations 023-035; T-22 unbuilt |
| T-22 §4.3 | `buy-negotiation-queue` in `ALL_QUEUE_CONFIGS` | **NOT FOUND** | `queues.ts` defines exactly 9 queues (confirmed by direct read); none is carrier-specific |
| T-23 §1 | Assignment and carrier acceptance are conflated (the spec's own headline finding, quoted in full at item 20) | **CONFIRMED gap** — stated by the spec author after reading the code, and independently reproduced by this investigation | `T23_Dispatch_Lifecycle_Monitor.md:22-26`; `dispatcher-worker.ts:138-139` |
| T-23 §4.2 | `carrier_acceptance_state` table | **NOT FOUND** | Not in any migration; T-23 unbuilt |
| T-20 §4.1 | `carrier_registry` — platform-level carrier identity | **NOT FOUND** | Not in any migration; live identity is only tenant-scoped `carriers` + `carrier_status` (migration 032) |
| T-20 §4.4 | `carrier_risk_signals` (the table T-25's Gate 2 would write into) | **NOT FOUND** | Not in any migration |
| T-20 §4.5 | `myra_carrier_scores` cross-tenant trust score | **NOT FOUND**, and even once built T-20 is explicitly additive/shadow-only (§7 acceptance criterion 6: "zero changes to `ranker-worker.ts`... or `match_results` write path") — so a *built* T-20 still wouldn't change live carrier selection | Not in any migration |
| T-25 §4.1-4.4 | "Gate 2" carrier verification, banking-change halt, payer credit cap | **NOT FOUND**, and the spec is explicit it wouldn't enforce anything live even once built | `T25_Risk_Fraud.md`: acceptance criterion 7, "Zero changes to `dispatcher-worker.ts` or any other live-path file" — the actual wiring is deferred again, to a still-later T-25b |

**Meta-finding**: T-20, T-22, T-23, T-25 are converging, independently-authored confirmations of one gap. Every one of them defers the actual code change to a still-later `*b` follow-on, gated on shadow-validation discipline that hasn't started (Engine 3 Phase 2 has not begun per `Engine 3/docs/superpowers/plans/completion.md`).

**26. Pilot 1 promises to Kevin — which can the code currently measure/enforce?**

`Myra_Engine2_Pilot1_Definition` — the document these promises are attributed to — **does not exist anywhere in this repository.** No file matches `*Pilot1*`; grepping for the exact phrases "1,000 carrier calls" and the carrier-booking-rate formula returns zero matches repo-wide, including inside E2-01 and `CLAUDE_CODE_BUILD_PLAN.md`. These promises exist only outside the git repository — likely a document Patrice/Kevin hold that was never checked in, or communicated verbally and only partially captured in derivative specs (`T25_Risk_Fraud.md:19,25,37` quotes fragments — kill criteria K1/K2, a 25% concentration cap — without reproducing the source).

| Promise (as found in-repo fragments) | Source | Code can measure/enforce it? |
|---|---|---|
| Gate 2 human carrier verification before any document issued | `E2-01_Engine2_Expansion_PRD.md:53`; `T25_Risk_Fraud.md:25,52-54` | **No** — T-25 unbuilt; only gate is the coarse `carrier_status='active'` flag (item 6), not NSC/insurance verification |
| Banking-change halt, cargo-loss/misdirected-payment kill criteria (K1) | `T25_Risk_Fraud.md:19,25,58-60` | **No** — not built, and T-25 explicitly won't wire into `dispatcher-worker.ts` even once built |
| "Carrier-side booking rate = loads booked ÷ carrier calls connected" | **NOT FOUND verbatim anywhere in repo** | **No** — requires a distinguishable carrier-call record, which requires the still-unresolved T-22 integration point (item 25) and an `agent_calls.call_type` discriminator that does not exist today |
| ~1,000 carrier calls (pilot volume target) | **NOT FOUND verbatim anywhere in repo** | N/A — no source document to check against |

---

## 4. Bugs and live-path debt (severity-ranked)

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 1 | **Critical** | No carrier is ever called, negotiated with, or asked to confirm before a rate-con PDF is generated and the load is marked `'Dispatched'`. `top_carrier_id` may be hours stale and its "rate" is a statistical average, not an agreement. | Items 3, 7, 10, 16 above; `dispatcher-worker.ts` full file |
| 2 | **High** | `createTMSLoad()` has no idempotency check; a `dispatch-queue` retry after a downstream step fails (assign, tracking) re-runs the entire job from the top, creating a **second duplicate `loads` row** for the same `pipeline_loads` entry. Found independently in this pass. | `dispatcher-worker.ts:89-165` (process function), retry config at lines 76-79 |
| 3 | **High** | `carrier_avg_rate` fallback to `0` on missing rate history silently inflates margin to 100% of revenue with no flag distinguishing it from a genuine zero-cost load. | `dispatcher-worker.ts:203-212`; `assign/route.ts:33-36` |
| 4 | **High** | Rate-con auto-send is a `console.log` stub. Nothing ever reaches the carrier, and assignment/dispatch does not wait on it. | `assign/route.ts:107-123` |
| 5 | **High** | No lifecycle monitoring covers a load once `dispatched` — no no-show, late-pickup, missing-check-call, or carrier-fall-off detection. The one stuck-load cron explicitly excludes `dispatched` from its check. | `cron-handlers.ts` (dead code); `pipeline-health/route.ts:51-58` |
| 6 | **Medium** | Two differently-named, easily-confused carrier gating columns on `carriers`: `authority_status` (matching filter) vs. `carrier_status` (dispatcher prospect gate). | `filters.ts:38`; `dispatcher-worker.ts:180` |
| 7 | **Medium** | `runFullComplianceCheck()`/`ComplianceService` — the purpose-built compliance gate, including carrier implied-consent logic — is never instantiated anywhere. A cruder inline check in `voice-worker.ts` runs instead, with no call-type awareness, and it only ever fires for shipper calls. | `compliance-service.ts` (no callers found); `voice-worker.ts:161-181` |
| 8 | **Medium** | `agreed_rate`/`profit` columns on `pipeline_loads` are shared between whatever call type populates them; a future carrier-call handler reusing `processCallCompleted()` unmodified would silently overwrite the shipper's negotiated numbers. | `retell-webhook.ts:854,856` |
| 9 | **Medium** | `AUTO_BOOK_PROFIT_THRESHOLD` is dead in the decision path (superseded by T-18's governance envelope) but still referenced in the live Sprint 6 shadow-drain operator runbook — an operator could believe they've disabled auto-booking when they haven't. | `.env.example:72`; `scripts/sprint6-shadow/05-live-call-preflight.ts:77-81` |
| 10 | **Low** | `MAX_CONCURRENT_CALLS` is a global active-call count with no per-load or per-carrier lock — a latent race if any future path allows concurrent job pickup on the same `briefed` row. | `voice-worker.ts:194-199` |

---

## 5. Spec-vs-code drift table

See §3.8, item 25 (full table with citations) — reproduced there in place to keep evidence adjacent to its citations, per the evidence standard in this audit's brief.

---

## 6. Ranked gap list — booked → carrier committed → rate con sent → dispatched autonomously

Each gap below follows the E2-01 pattern: does it change the live call path, and what would it reuse?

| Priority | Gap | Changes the live call path? | What it would reuse |
|---|---|---|---|
| 1 | A carrier-calling worker + queue that actually places a call on the ranked stack before assignment | **Yes — the highest-risk change in this whole gap list.** Adds a new outbound call surface. | `voice-worker.ts`'s structure (`BaseWorker`, stage validation, `agent_calls` insert pattern) and `retell-webhook.ts`'s webhook-ingestion machinery, both already proven on the shipper side |
| 2 | A cascade/fallback loop over the top-3 carrier stack (not just `top_carrier_id`) with a decline/no-answer branch | Yes, but only activates once gap 1 exists | `match_results`' already-persisted ranked stack (currently write-only/audit-only — would need to become read-side too) |
| 3 | A `call_type` discriminator on `agent_calls` (and separate write columns, or a join key) so carrier and shipper outcomes never collide | No — additive schema change | Existing `agent_calls` table shape; mirrors the `outbound_shipper` literal already in place |
| 4 | A carrier-side negotiation envelope function (max/target/walk-away derived from the agreed shipper rate) with an enforced margin floor in code, not prompt text | No, until wired into a carrier-calling worker | `cost-calculator.ts`'s existing shipper-side envelope pattern (`calculateNegotiationParams`) as a structural template |
| 5 | Idempotency guard on `dispatcher-worker.ts`'s `createTMSLoad()` step (fixes the duplicate-load-on-retry bug, §4 item 2) | No — pure correctness fix, no new call surface | Existing `pipeline_loads.tms_load_id` column as the natural idempotency key |
| 6 | A real rate-con send (email/fax/API) replacing the `console.log` stub, gated on carrier confirmation before dispatch flips `'Dispatched'` | Yes, if it becomes a hard precondition | Existing `generateRateCon()` + Vercel Blob attach path, already built and working |
| 7 | Post-dispatch lifecycle monitoring (no-show, late pickup, fall-off) — T-23's proposed `carrier_acceptance_state` + event taxonomy | No — purely observational, read-side | T-17's `events` table (already shipped to production) as the write target, once T-23 is prioritized |
| 8 | Human-verification gate ("Gate 2": NSC/insurance-from-insurer check) before a rate-con document is issued | No — a precondition on an existing step | `carrier_status` column pattern (migration 032) as the mechanism template; would need a genuinely new verification data source (none exists today per E2-01 §0.1) |
| 9 | Carrier-side kill switch independent from `PIPELINE_ENABLED`/`MAX_CONCURRENT_CALLS`, so shipper calls can run live while carrier calls stay in shadow | Yes, in the sense that it's a precondition for safely shipping gap 1 | The existing env-flag pattern (`PIPELINE_ENABLED`, `SCANNER_ENABLED`), just namespaced for the carrier leg |

---

## 7. Open questions for the founder

These cannot be answered from the code — they require information the repository does not contain.

1. Where does `dispatch_one_v1.json` actually live? It is referenced in this investigation's own required-reading list and in four T-series specs (T18, T21, T22, T23) as if it were a wired Retell config, but it does not exist anywhere in this repository — is it a dashboard-only artifact inside the Retell console (never exported to git), a planned-but-never-authored file, or does it live in a location outside `M1/`?
2. Where does `Myra_Engine2_Pilot1_Definition` live? It is listed as a `depends_on` in E2-01's own frontmatter, but no file matching it exists anywhere in the repo. The specific promises this investigation was asked to check against it (Gate 2 wording, the carrier-booking-rate formula, the ~1,000-call pilot volume) could not be located in any checked-in document.
3. Same question for `T-00` (the "Engine 2 system report" cited as E2-01's parent document and referenced directly in this investigation's checklist as "T-00 §2.2") — not found as a file.
4. `T22_Negotiation_Service.md`'s own acceptance criterion 6 treats "is Dispatch One actually connected to the orchestrator" as an open, unresolved question as of that spec's writing. Given this investigation's finding that no such connection exists in code today, is Dispatch One presently just a Retell-dashboard configuration with no live wiring, or was it ever wired in a version of the code this investigation didn't have access to (e.g., a different branch, a pre-refactor commit)?
5. Given migration `030_engine2_tenanting.sql.PENDING` is explicitly staged/not-applied, and this entire sell-side path writes to un-tenanted Engine 2 tables — is any near-term multi-tenant activation expected to land before or after a carrier-calling capability is built, since that changes the shape of every new table this gap list would add?
