---
title: Engine 2 Sell-Side Expansion — Carrier Confirmation Gate & the Dispatch One Build
id: E2-03
version: 1.0
date: 2026-08-25
owner: Patrice Penda
status: draft
classification: Technical — Engineering + Founder
supersedes: []
depends_on: [E2-01, E2-02, T-07, T-09, T-10, T-12, T-13, T-20, T-22, T-23, T-25]
referenced_by: []
note: |
  Single PRD for the Engine 2 sell-side expansion, built directly on the E2-02
  investigation's findings (evidence cited as "E2-02 §x.y"). M0 is the only
  true P0 and is small on purpose — it ships in days, not weeks, because it
  closes an active misrepresentation, not a latent risk. M2 (Dispatch One) is
  the real build and is deliberately NOT flagged default-ON the way E2-01's
  gate was — see §6.4 for why the two PRDs take opposite postures on purpose.
---

# E2-03 — ENGINE 2 SELL-SIDE EXPANSION
## Carrier Confirmation Gate & the Dispatch One Build

| Field | Value |
|---|---|
| Document | E2-03 (sell-side expansion) |
| Version | 1.0 |
| Date | 2026-08-25 |
| Owner | Patrice Penda, Founder |
| Status | DRAFT — awaiting decisions in §12 |
| Parent | E2-02 (sell-side investigation, cited throughout) |
| Build tool | Claude Code, one module per session, M0 first and separately |
| Live path | **Yes**, and M2 specifically places a new class of outbound call that has never existed before — see §6.4 on why this module is paced differently from E2-01's gate. |

---

## 0. Reconciliation flag — read before Session 1

E2-02 §3.8 (item 26) and §7 (open questions 1–3) report that `dispatch_one_v1.json`, `Myra_Engine2_Pilot1_Definition`, and `T-00` (the Engine 2 system report) **do not exist anywhere in the live repository Claude Code scanned.** All three exist in this project's knowledge base and were read directly to write E2-01 — `dispatch_one_v1.json` is a 49 KB Retell agent config; the Pilot 1 document is the source of the Gate 1/Gate 2 promises to Kevin; T-00 is cited as E2-01's own parent document.

This is not a contradiction to panic over — E2-02's own evidence standard (its §4) anticipated exactly this: *"distinguish the project snapshot from the deployed repo when they differ."* It found a difference. Three explanations, in order of likelihood:

1. These are founder-held or Claude-session-generated documents that were never committed to the git repository Claude Code has access to — plausible for T-00 (a living status report) and the Pilot 1 doc (reads as an external-facing document, possibly authored or maintained outside the codebase).
2. `dispatch_one_v1.json` is genuinely dashboard-only — configured directly in Retell's UI and never exported to a file, which would make E2-02's finding literally correct: the code has no wired connection to it because there is nothing to wire to in git, even if the agent exists and is reachable by ID inside Retell.
3. Claude Code's scan missed a directory, submodule, or branch.

**Before Session 1:** confirm which. If (2), export the live Retell config for the carrier-side agent (if one exists under any name in the Retell dashboard) so M2 Session 1 can audit an existing prompt/variable contract instead of authoring one from nothing — reuse instructions in this PRD assume that export happens first. If none exists in Retell either, M2 authors fresh, and that should be stated explicitly rather than assumed.

This also means: **do not treat E2-02's "NOT FOUND" verdicts on Pilot 1 promises (Gate 2, the ~1,000-call target, the carrier-booking-rate formula) as evidence those promises were abandoned** — they weren't found in the *scanned repo*, not disproven. Kevin's actual commitments still stand; this PRD still has to make them true in code.

---

## 1. What E2-02 actually found, in one paragraph

A booked load reaches `stage='dispatched'`, carrier assigned, rate-con PDF generated, tracking link sent to the shipper — **with zero carrier ever contacted** (E2-02 §1, §2 step 5–8). The Dispatcher reads a single `top_carrier_id` frozen at qualification time (E2-02 §3.2 item 3), checks one binary `carrier_status='active'` flag, and if it passes, calls `/assign` unconditionally. `voice-worker.ts` — the only call-placing worker in the pipeline — is wired exclusively to the shipper flow; no carrier queue, no carrier Retell agent, no cascade over the ranked stack exists (E2-02 §2 steps 5–8, §3.3 item 10). The "carrier rate" feeding the margin calculation is the Ranker's historical-average scoring artifact, not a negotiated number, and silently defaults to `$0` — 100% margin — when a carrier has no rate history (E2-02 §3.5 item 18). The rate-con carrier-send step is a `console.log` stub (E2-02 §3.5 item 17). Post-dispatch, nothing watches for no-show, late pickup, or carrier fall-off (E2-02 §3.6 item 20). Independently, E2-02 found a duplicate-load-creation bug on job retry (§4 item 2) with no relation to the missing carrier call at all.

**The framing that sets priority:** this is not "a feature is missing." It is "the system currently tells the shipper a carrier is moving their freight when no carrier has agreed to anything." That statement is true of every load that has reached `dispatched` via this path. M0 exists to make it stop being true this week, before M2 — the actual capability — is built.

---

## 2. Objective

> **Engine 2 assigns a carrier only once a real carrier has actually agreed to run the load, at a rate someone actually offered them — and until that capability exists live, it says so honestly instead of fabricating the assignment.**

---

## 3. Scope

| Module | Name | Priority | Effort | Live path? |
|---|---|---|---|---|
| **M0** | Stop the bleeding: kill unconditional auto-assign; three standalone bug fixes | **P0** | Days | Yes — behavior change, ships this week |
| M1 | `call_type` discriminator schema (agent_calls + pipeline_loads carrier columns) | P0 (ships with/right after M0) | Small | Additive schema only, no behavior change |
| M2 | **Dispatch One** — carrier-calling worker, queue, ranked-stack cascade, enforced negotiation envelope | P1 | Multi-session, the real build | Yes — new outbound call surface, shadow-first (§6.4) |
| M3 | Real rate-con send + gate dispatch on carrier confirmation | P1 | Small | Yes, depends on M2 |
| M4 | Gate 2 carrier verification (reuses E2-01's authority-lookup client) | P1/P2 | Medium | Yes, precondition on an existing step |
| M5 | Lifecycle monitoring lite (T-23 slice: no-show, late pickup, fall-off) | P2 | Small | No — observational |
| M6 | Hygiene: per-carrier locks, `carrier_lanes` auto-update, independent carrier kill switch | P2 | Small | Partial |

**Out of scope:** multi-tenancy (030 pending, per E2-02 §7 Q5); the full T-20/T-22/T-23/T-25 builds — this PRD ships the minimum live slice each of those specs already defers to a `*b` follow-on; any change to the shipper-side voice flow; automated driver/DApp assignment (E2-02 §3.5 item 19 — stays a separate, human-triggered TMS action).

---

## 4. Sequencing

```
This week            Week 2                  Weeks 3–5                Week 6
├── M0 (ship first,   ├── M1 schema          ├── M2 Sessions 1–4      ├── M4 Gate 2
│   standalone)       │                       │   (shadow validation   ├── M5 lifecycle lite
│                     │                       │   gate before live)    └── M6 hygiene
│                     │                       └── M3 (with M2 Session 4)
```

M0 does not wait for anything. It is a behavior removal and three bug fixes against code that exists today; it has no dependency on M1 or M2. Ship it standalone, this week, separately from the rest of this document.

---

## 5. M0 — Stop the bleeding

### 5.1 Design principle

Same discipline E2-01 applied to poster identity, applied here to carrier commitment: **unconfirmed is not neutral.** A load with no real carrier agreement behind it must not present as `dispatched`, must not generate a rate-con addressed to a carrier who was never asked, and must not send the shipper a tracking link implying movement that isn't happening.

### 5.2 The behavior change

`dispatcher-worker.ts`'s terminal branch today (E2-02 §2 step 11, §3.3 item 10):

```
active carrier → assignCarrier() → /assign → 'Dispatched' → tracking link sent
```

becomes:

```
active carrier → HOLD: 'carrier_needed' exception, Alert Center, human secures by phone
                  (exactly the existing prospect-gate escalation path — same table,
                   same UI, new source_module — nothing new to build here)
```

This is a subtraction, not an addition. No new queue, no new worker, no new call surface — it reuses the escalation path that already exists for the prospect gate (E2-02 §3.2 item 6) with a new `source_module = 'carrier_confirmation_required'` and `suggested_action`: *"Secure a carrier for this load by phone. AI carrier calling is not yet live."* Every load that would have silently auto-dispatched instead becomes a visible, workable queue item — this is strictly more honest than what exists today, and no worse operationally than if Engine 2's sell side didn't exist yet, which as of E2-02's findings, it functionally doesn't.

### 5.3 Flag

`CARRIER_AUTO_ASSIGN_ENABLED` — **default `false` on deploy.** This is the one flag across both PRDs in this arc that defaults OFF, and correctly so: E2-01's gate defaulted ON because turning it on *closes* an exposure. This flag defaults OFF because turning the *current* behavior off is what closes the exposure — the existing always-on unconditional assign is the dangerous state, not the guarded one.

### 5.4 Bundled bug fixes

These are unrelated to the missing carrier call but are cheap, isolated, and dangerous enough to ship in the same PR rather than wait for M2:

1. **Idempotency guard on `createTMSLoad()`** (E2-02 §4 item 2, severity High). `dispatcher-worker.ts`'s `process()` has no checkpoint before creating the TMS load row; a `dispatch-queue` retry after a downstream failure re-runs from the top and creates a second `loads` row for the same `pipeline_loads` entry. Fix: check `pipeline_loads.tms_load_id IS NOT NULL` before calling `POST /api/loads`; if set, skip creation and resume from the next step. Natural idempotency key already exists — this is purely a missing guard, not a new column.
2. **`carrier_avg_rate = 0` fallback masking margin** (E2-02 §4 item 3, severity High). When a carrier has no rate history, `fetchCarrierRate()` falls back to `0`, producing `margin = revenue`, 100% margin, indistinguishable from a genuine zero-cost load. Fix: add `carrier_cost_estimated BOOLEAN` to the TMS load write; set `true` whenever the fallback path fires; surface it as a visible flag anywhere margin is displayed. Does not fix the underlying "no real carrier rate" problem — M2 does that — but stops the number from lying about its own confidence in the interim.
3. **`AUTO_BOOK_PROFIT_THRESHOLD` dead-reference cleanup** (E2-02 §4 item 9, severity Medium). The variable is dead in the actual decision path (superseded by T-18's governance envelope per the live `.env.example` comment) but still referenced in `scripts/run-workers.ts`, the Sprint 6 shadow-drain preflight scripts, and the operator runbook. An operator following the runbook today believes they're gating auto-book with a variable the system no longer reads. Fix: update the runbook and the three scripts to point at wherever T-18's envelope value actually lives, or remove the references and replace with an explicit "this is now governed by T-18, see [link]" note. This is a documentation/tooling fix, not a code-path fix — flag it as such so it doesn't get scoped bigger than it is.

### 5.5 Acceptance criteria

1. `CARRIER_AUTO_ASSIGN_ENABLED=false` deployed; every load that reaches the Dispatcher's active-carrier branch now escalates instead of auto-assigning. Confirmed against a synthetic booked load in staging.
2. Alert Center shows the `carrier_confirmation_required` exception with the evidence a human needs (load details, `top_carrier_id`, contact info) to secure the carrier by phone without opening the TMS load record separately.
3. A forced retry of a `dispatch-queue` job (simulate a downstream failure after `createTMSLoad()`) produces exactly one `loads` row, not two.
4. A carrier with zero rate history produces a load with `carrier_cost_estimated=true` visible on the load detail view.
5. Runbook and the three scripts updated; `grep -r AUTO_BOOK_PROFIT_THRESHOLD` returns only the updated references, no stale ones.
6. Human code review before merge — this changes live dispatch behavior for every in-flight and future booked load.

### 5.6 Rollout

Deploy directly to production the same week. No shadow period needed — the change is strictly more conservative than current behavior (escalate instead of auto-assign), so there is no failure mode where this makes anything worse. Tell Kevin: *"Every load that books now correctly stops for a human to secure the carrier by phone, same as before Engine 2 existed for this leg — the difference is it's now visible and instrumented, and it was silently pretending to complete before."* That sentence is worth saying to him directly and promptly; it's the kind of transparent correction that built trust the first time (per memory: Kevin responded well to the classifier disclosure).

---

## 6. M2 — Dispatch One

### 6.1 What this module builds

The actual missing capability: a carrier-calling worker that takes the Researcher/Ranker's ranked carrier stack, calls carriers in order, negotiates within an enforced envelope, and reports a real accept/decline back into the pipeline — replacing M0's human-escalation hold with genuine automation, once validated.

### 6.2 Carrier stack — read-side, not new data

`match_results` already persists the full ranked stack with scores (E2-02 §3.2 item 3) — it is currently write-only/audit. M2 makes it read-side: the cascade worker reads the top-N (default 5, §12-D4) carriers for the load instead of the single frozen `top_carrier_id`. No new ranking logic — this is exactly the data the Ranker already computes, just actually used.

### 6.3 Architecture — mirrors `voice-worker.ts` deliberately

New queue `carrier-call-queue`, new worker `carrier-voice-worker.ts`, same `BaseWorker` pattern, same stage-validation discipline, same `agent_calls` insert pattern — proven infrastructure, not a new pattern to debug. Cascade state machine:

```
call carrier[i] → outcome
  accept          → write carrier_agreed_rate, carrier_id_secured; proceed to M3 (rate-con + dispatch)
  decline         → i += 1; if i > N: exhaust (below)
  voicemail       → retry once at +2h (per shipper-side calling-hours discipline); then treat as decline
  no_answer       → same as voicemail
  disconnected    → same as voicemail
  exhausted (i>N) → escalate to human: 'carrier_cascade_exhausted', all N declined/unreachable —
                     visible, not silent, same Alert Center pattern as M0
```

Concurrency: **per-load Redis lock** (only one cascade worker processes a given load's carrier stack at a time) and **per-carrier-phone Redis lock** (a carrier is never dialed twice concurrently across different loads' cascades) — both are gaps E2-02 flagged as latent (§3.3 item 11, §4 item 10) even before any carrier-calling worker existed; M2 is the first place they become load-bearing, so they ship with M2, not after.

### 6.4 Why M2 is shadow-first, unlike E2-01's gate

E2-01's hard gate defaulted ON immediately because it is conservative by construction — a classifier that fails toward rejection can only ever prevent bookings, never cause new harm. **M2 is the opposite kind of change: it places live outbound calls to real carrier dispatchers.** A bug in the cascade logic, the negotiation envelope, or the concurrency lock doesn't just misclassify a load — it can double-dial a carrier, make a bad offer that damages a relationship Patrice is actively building (C-01 Carrier Acquisition Playbook), or negotiate a rate with no real margin floor behind it. That is a materially different risk profile and it gets a materially more cautious rollout: build against synthetic fixtures and a shadow drain (same discipline T-18 applies to authority evaluation) before a single real carrier call is placed, with explicit sign-off between shadow and live — not a default-ON flag.

### 6.5 Negotiation envelope — enforced in code, not prompt text

E2-02 §3.3 item 9 found no carrier-side envelope function anywhere; `cost-calculator.ts`'s only negotiation function computes what Myra offers the *shipper*. M2 adds `calculateCarrierNegotiationParams(agreedShipperRate, minMarginPct)` — ceiling = `agreedShipperRate - minMarginFloor`, target, opening offer — and **the ceiling is enforced as a hard reject in the cascade logic**, not left to the Retell prompt to honor. If the agent's transcript reports an accepted rate above the ceiling, the outcome is rewritten to `escalated` server-side, not booked — the same fail-closed posture as everything else in this arc.

### 6.6 Data model additions (M1, ships ahead of/with M2)

```sql
-- M1: call_type discriminator — closes E2-02 §4 item 8 (shared-column collision risk)
ALTER TABLE agent_calls
  ALTER COLUMN call_type DROP DEFAULT,  -- was hardcoded 'outbound_shipper'; now a required param
  ADD CONSTRAINT chk_call_type CHECK (call_type IN ('outbound_shipper','outbound_carrier'));

ALTER TABLE pipeline_loads
  ADD COLUMN IF NOT EXISTS carrier_agreed_rate      DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS carrier_agreed_currency   VARCHAR(3),
  ADD COLUMN IF NOT EXISTS carrier_call_outcome      VARCHAR(30),
  ADD COLUMN IF NOT EXISTS carrier_id_secured        INTEGER REFERENCES carriers(id),
  ADD COLUMN IF NOT EXISTS carrier_cascade_position  INTEGER,   -- which stack position secured it
  ADD COLUMN IF NOT EXISTS carrier_cost_estimated    BOOLEAN DEFAULT false,  -- M0 fix, lands here too
  ADD COLUMN IF NOT EXISTS carrier_profit            DECIMAL(10,2);
  -- deliberately separate from agreed_rate/profit (shipper columns) — the exact fix for
  -- E2-02 §4 item 8, and it ships even before M2's worker exists so the schema and the
  -- webhook branch (§6.7) can be tested against synthetic carrier fixtures first.
```

### 6.7 Webhook branch — built and tested before any real call

`retell-webhook.ts`'s `processCallCompleted()` branches on `call_type` from the start of M1, not deferred to M2: a synthetic `call_type='outbound_carrier'` fixture must produce a correct write to the new carrier columns, never touching `agreed_rate`/`profit`, before M2 Session 1 places any real call. This is the concrete fix for E2-02's most consequential "would silently overwrite" finding (§4 item 8) — closed structurally, ahead of the feature that would otherwise trigger it.

### 6.8 Test plan

**Synthetic (required before shadow):** full cascade fixture set — accept on carrier 1; decline-then-accept on carrier 2; full exhaustion (all N decline); voicemail-then-retry-then-accept; envelope breach (agent reports above-ceiling rate → server-side reject); concurrent-dial attempt on the same carrier phone (lock must block the second). Minimum 12 cases, 100% pass.

**Shadow (required before live):** run the cascade worker against a batch of already-`booked` loads with `CARRIER_CALLING_ENABLED=shadow` — computes and logs the full cascade decision at every step, places zero real calls (same shadow-mode pattern as `MAX_CONCURRENT_CALLS=0` on the shipper side). Review the log by hand: does the envelope math look right, does the cascade order match the ranked stack, does nothing double-fire.

**Live:** one real call, one real carrier, low concurrency — same Phase 0 discipline T-00 applied to the very first shipper call. Gate: do not proceed past one validated real carrier call until the full chain (`call → outcome → webhook → carrier columns written → M3's rate-con → dispatch`) is confirmed correct end to end.

### 6.9 Acceptance criteria

1. 12+ synthetic cascade cases, 100% pass.
2. Shadow drain against ≥20 real booked loads: cascade order, envelope enforcement, and lock behavior all correct on manual review.
3. Explicit founder sign-off between shadow and live (not a flag default — a decision, logged).
4. One real carrier call validated end to end before `CARRIER_AUTO_ASSIGN_ENABLED` (M0's flag) is ever flipped back toward automated.
5. Per-carrier-phone lock verified: a forced concurrent-dial test on the same number is blocked, not raced.

---

## 7. M3 — Real rate-con send + confirmation gate

Replaces the `console.log` stub (E2-02 §3.5 item 17) with a real send — email first, via the existing Nodemailer/SMTP path already used for shipper invite emails (platform completeness doc), carrier SMS as a v2 if pickup urgency demands it. More importantly: **dispatch does not flip to `'Dispatched'` or send the shipper's tracking link until `carrier_call_outcome = 'accept'` AND the rate-con send has been attempted and logged.** Today (E2-02 §3.5 item 17) assignment succeeds even if PDF generation fails and the send is best-effort with no gate at all — this module makes "rate con sent" a real precondition of "dispatched," not a decorative step that happens to run in the same request.

---

## 8. M4 — Gate 2 carrier verification (reuses E2-01)

E2-02 §3.2 item 5 confirms: no verification gate exists beyond the coarse `carrier_status='active'` flag, and platform-wide there is no FMCSA/SAFER/NSC lookup client (independently confirmed in both E2-01 §0.1 and E2-02). **This module does not build a second lookup client.** It calls `lib/verification/authority-lookup.ts` from E2-01 M1 — same FMCSA/SAFER chain, same cache, same audit table — with the question flipped: instead of "is this poster a shipper or a broker," it asks "is this carrier's authority active, is the legal name a match, is there an operating-classification red flag." Adds `carriers.verified_at`, `verified_by`, `verification_snapshot JSONB`, populated by the lookup or a human confirmation, checked as a precondition before M3's rate-con send. This is the software form of Pilot 1's Gate 2 promise and closes it the same way E2-01 closed Gate-equivalent promises on the buy side — one shared verification asset, two consuming modules.

---

## 9. M5 — Lifecycle monitoring lite

Minimum viable slice of T-23 (E2-02 §3.6 item 20 confirms everything past delivered-status-advancement is `NOT FOUND`): extend the existing `pipeline-health` cron to stop excluding `'dispatched'` from its stuck-load check (E2-02 §3.6 item 20 flags this exclusion as the reason a load stuck at `dispatched` for days is currently invisible), and add a late-pickup / missing-check-call threshold using the same `time-in-stage` metric T-00 already specifies for the buy side. Purely observational — writes to `exceptions`, no new automation, no dependency on M2 being live.

---

## 10. M6 — Hygiene

Per-load and per-carrier-phone Redis locks generalized beyond M2's cascade to the existing shipper-side `MAX_CONCURRENT_CALLS` count, which E2-02 §3.3 item 11 and §4 item 10 flag as a global count with no actual lock — a latent race today, load-bearing once any concurrent job pickup happens on the same row. `carrier_lanes.on_time_rate`/`avg_carrier_rate` currently only update via a manual, uncronned endpoint (E2-02 §3.6 item 22) — wire `feedback-worker.ts` to update them on `stage='scored'`, mirroring the shipper-side `lane_stats` nightly job it already runs. Independent carrier-side kill switch `CARRIER_CALLS_ENABLED` separate from `PIPELINE_ENABLED`/`MAX_CONCURRENT_CALLS` (E2-02 §3.7 item 23 confirms no such separation exists) — needed before M2 goes live regardless of M0, since it's what lets the shipper side keep running live while the carrier side sits in shadow.

---

## 11. Spec reconciliation — exact edits

| Spec | Current text | Replace with |
|---|---|---|
| T-10 §4 | `assignWithFallback()` pseudocode, described as if built | "Implemented as M2's cascade worker (E2-03 §6.3), not inside `dispatcher-worker.ts` itself — the Dispatcher now consumes a *secured* carrier from the cascade rather than performing fallback logic in-line." |
| T-10 §3 | `AUTO_BOOK_PROFIT_THRESHOLD` phased decision tree | Retire this section; point to T-18's governance envelope per the live `.env.example` note E2-02 §3.8 item 24 found, and to M0 §5.4.3's cleanup. |
| T-22 §1, §3.1, acceptance criterion 6 | "Dispatch One... connected to the Engine 2 orchestrator" treated as an open task | Resolve per §0 of this document first. If Dispatch One's config is recovered from Retell, T-22 should cite E2-03 M2 as the actual connection point; if authored fresh, T-22's acceptance criterion 6 is satisfied by M2 Session 1's audit, not by finding a pre-existing file. |
| T-22 §4.3 | `buy-negotiation-queue` in `ALL_QUEUE_CONFIGS` | `carrier-call-queue` (E2-03 §6.3) — same concept, actual name as built. |
| T-23 §1, §4.2 | `carrier_acceptance_state` full spec | M5 ships a deliberately smaller slice (§9); T-23's full table and event taxonomy remain a later Engine 3 Phase 2 item, not superseded, just not built yet — note the relationship explicitly rather than letting T-23 imply it's still all outstanding with no interim coverage. |
| T-20 §4.4, §4.5 | `carrier_risk_signals`, `myra_carrier_scores` | Unaffected by this PRD — M4 uses E2-01's authority-lookup output directly on `carriers`, not through T-20's cross-tenant registry, which remains future work. |
| T-25 §4.1 | "Gate 2" carrier verification, deferred to T-25b | M4 (§8) is the live version of this, built now rather than deferred — update T-25 to point at E2-03 M4 as done, not still-outstanding. |

---

## 12. Decisions required before Session 1

| # | Decision | Default (my pick) | Alternative |
|---|---|---|---|
| D1 | Reconcile `dispatch_one_v1.json`/Pilot 1 doc/T-00 location (§0) before Session 1 | **Yes, blocking for M2 only** — M0 doesn't need this and should not wait | Proceed without reconciling; M2 authors a carrier agent from scratch, possibly duplicating a real one sitting unexported in Retell |
| D2 | Ship M0 immediately, standalone, this week | **Yes** | Bundle it into the same review cycle as M1/M2 — not recommended, it's the highest-leverage fix in this document and the cost of waiting is measured in fabricated dispatches, not developer time |
| D3 | M2 shadow-first vs. default-ON like E2-01's gate | **Shadow-first** (§6.4) | Ship faster, same posture as E2-01 — not recommended; the risk classes are different (classification filter vs. live outbound calls to a relationship-sensitive carrier network) |
| D4 | Cascade depth before exhaustion-escalation | **5 carriers** | Fewer (faster escalation, more human load) or more (longer AI-only window, more carrier contact volume per load) |
| D5 | Rate-con channel v1 | **Email** (existing SMTP infra, fastest) | SMS/fax from day one — more carrier-native but new infra |
| D6 | M3's dispatch-confirmation gate: block on rate-con *delivery confirmation* or just *send-attempted* | **Send-attempted-and-logged** | Full delivery confirmation (read receipt / carrier portal ack) — stronger guarantee, no existing infra to check it today |

---

## 13. Claude Code build plan

**Session 0 — M0, standalone, this week**
1. `CARRIER_AUTO_ASSIGN_ENABLED` flag, default `false`; escalation branch reusing the prospect-gate Alert Center pattern.
2. Idempotency guard on `createTMSLoad()`.
3. `carrier_cost_estimated` flag on the zero-rate fallback path.
4. Runbook/script cleanup for `AUTO_BOOK_PROFIT_THRESHOLD`.
5. Human review, merge, deploy directly — no shadow period (§5.6).

**Session 1 — M1 schema + webhook branch (no live-path change)**
6. Migration: `call_type` constraint, carrier columns on `pipeline_loads` (§6.6).
7. `processCallCompleted()` branches on `call_type`; synthetic carrier-outcome fixture proves it writes carrier columns, never shipper columns.

**Session 2 — M2 cascade worker (flag OFF / shadow only)**
8. `carrier-call-queue`, `carrier-voice-worker.ts` mirroring `voice-worker.ts`'s `BaseWorker` structure.
9. Read `match_results` top-N stack; cascade state machine (§6.3).
10. Per-load and per-carrier-phone Redis locks.
11. 12+ synthetic cascade fixtures, 100% pass.

**Session 3 — Negotiation envelope + M4 verification**
12. `calculateCarrierNegotiationParams()`; server-side ceiling enforcement (§6.5).
13. M4: wire `lib/verification/authority-lookup.ts` (from E2-01) to `carriers.verified_at`/`verified_by`; precondition check before rate-con send.

**Session 4 — M3 real send + confirmation gate; shadow drain; ship**
14. Real rate-con send (email); confirmation-gate on dispatch flip.
15. Shadow drain against ≥20 real booked loads (§6.8); founder review and sign-off.
16. One real carrier call, validated end to end. Only then discuss flipping `CARRIER_AUTO_ASSIGN_ENABLED` back toward automated — as its own decision, not a side effect of merging code.

**Session 5 — M5/M6 hygiene**
17. Stuck-load cron stops excluding `dispatched`; late-pickup threshold check.
18. `feedback-worker.ts` updates `carrier_lanes` on `scored`.
19. `CARRIER_CALLS_ENABLED` independent kill switch.
20. Spec reconciliation edits (§11) as a doc commit.

Do not let Claude Code: skip the shadow drain in Session 4 because Session 2's synthetic tests passed; flip `CARRIER_AUTO_ASSIGN_ENABLED` as part of a merge rather than a standalone, explicit founder decision; author a new `dispatch_one_v1.json`-equivalent without first checking whether §0's reconciliation turned up a real one; touch the shipper-side `voice-worker.ts` call logic while building the carrier-side worker next to it.

---

## 14. Risks

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| E2-R8 | M0 ships late and fabricated dispatches continue accumulating in the interim | High | This is the reason M0 is scoped to ship standalone, this week, ahead of everything else in this document. |
| E2-R9 | M2's cascade double-dials a real carrier or makes an out-of-envelope offer during shadow-to-live transition | High | Per-carrier-phone lock (§6.3), server-side envelope enforcement (§6.5), explicit sign-off gate before live (§6.4, §6.9). |
| E2-R10 | A runaway or poorly-tuned cascade damages relationships with carriers Patrice is actively recruiting (C-01) | Medium | Cascade depth capped at 5 (§12-D4), exhaustion escalates to human rather than looping; shadow drain reviewed by hand before any real dial. |
| E2-R11 | `dispatch_one_v1.json` turns out to exist live in Retell and M2 duplicates it | Medium | §0 reconciliation, blocking for M2 only. |
| E2-R12 | M4's verification depends on the same FMCSA rate limits E2-01's gate already consumes | Low | Shared cache (`authority_lookups`) already amortizes this across both consumers — no new rate-limit exposure, just more cache hits. |

---

## 15. Metrics

| Metric | Target | Why |
|---|---|---|
| Fabricated-dispatch rate (post-M0) | **0** | The number that matters this week |
| Cascade acceptance rate (carrier 1 vs. cascade-required) | reported | Tells you how good the Ranker's top pick actually is |
| Cascade exhaustion rate | <15% | Above that, the ranked stack isn't deep/accurate enough |
| Carrier calls connected → carrier-side booking rate | reported | This is the exact metric E2-02 flagged as unmeasurable today (§3.8 item 26) — first real reading of it |
| Rate-con send success rate | >95% | M3's whole point |
| `carrier_cost_estimated=true` share of loads | reported, watch for decline | Should shrink as carrier rate history accumulates |

---

*End of E2-03. M0 ships this week on its own. Everything else in this document earns its place behind it.*
