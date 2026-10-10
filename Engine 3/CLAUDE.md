# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Directory Is

This directory holds the master PRD and 14 child specs for "Myra Engine 3 — Autonomous Brokerage Operating System," the roadmap phase that follows [[Engine 2]] (the load-acquisition + sell-side pipeline, deployed in shadow-drain mode from `MyraTMS/`). **The spec files here are reference material — none of them are compiled or imported.** The actual code for shipped modules lives in `MyraTMS/lib/{governance,tenants,carriers,pricing,negotiation,dispatch,exceptions,risk,documents,finance,contract-intake}/`, the matching `MyraTMS/app/api/**` routes, and migrations 033–035, 044–045, 052–059 under `MyraTMS/scripts/`; see the status table below for what's actually built. Don't run anything from inside this directory.

> **Docs ↔ code sync:** reconciled against `master` @ `41afeb6` on 2026-10-07. When a module lands, update `docs/superpowers/plans/completion.md` **and** the status table below (and the root `CLAUDE.md`) in the same commit. Next step for this engine: `../docs/next-steps/ENGINE3.md`.

**One-sentence definition (from the master PRD):** Engine 2 autonomously executes profitable freight transactions; Engine 3 autonomously operates the brokerage around those transactions, for any tenant, under explicit human authority boundaries. Engine 2 does not disappear — it becomes the Freight Acquisition & Booking service inside Engine 3 (see §6.1 of the master PRD).

**Spec copies:** this directory is the only canonical location for T-17..T-30 and the master PRD. On 2026-10-07 the untracked duplicates that had accumulated in `MyraTMS/` root and `Engine 2/` were removed, after first porting the one thing they had that these files lacked — the "Reconciliation note (E2-03, 2026-08-25)" sections in T22/T23/T25, which point at the E2-03 modules that actually built what those specs describe. `T22_Negotiation_Service (1).md` (a byte-identical duplicate) was also removed. Don't let a new copy appear elsewhere; edit here.

## Current status (as of 2026-10-07 — Phases 1–3 and T-28 built and applied to production; T-30 merged to `master` 2026-10-09, migration 059 unapplied, finalize cron held; T-29 not started; everything from T-20 on is shadow mode and was built ahead of the formal handoff gate at Patrice's explicit direction — see §9 and `docs/superpowers/plans/completion.md`)

| Module | Status | Notes |
|---|---|---|
| T-17 Event & Data Layer | ✅ Shipped to production | `events` table, 5 exception-safe triggers deriving from Engine 2's existing tables, 4 metric views |
| T-18 Agent Runtime & Governance | ✅ Shipped to production | `agents`/`authority_envelopes`/`authority_evaluations`/`escalations`; shadow mode only |
| T-19 Tenant & Policy Model | ✅ Shipped to production | Redesigned against the real (already-shipped) multi-tenant schema rather than the base spec's assumptions; fixed a real tenant-id mislabeling bug across T-17/T-18 |
| T-20 Carrier Intelligence | ✅ Built + applied to production, shadow mode | `carrier_registry`/`myra_carrier_scores`; 5/7 criteria pass, 2 held open pending real Pilot 1 volume |
| T-21 Pricing Engine | ✅ Built + applied to production, shadow mode | `lib/pricing/`; 4 of 5 criteria pass (criterion 5 build-complete, not exercised live) |
| T-22 Negotiation Service | ✅ Built + applied to production, shadow mode | `lib/negotiation/`; 5/7 criteria pass, 2 held open pending real-world conditions |
| T-23 Dispatch & Load Lifecycle Monitor | ✅ Built + applied to production, shadow mode | `carrier_acceptance_state`/`dispatch_routing_rules`/`v_lifecycle_late_loads`; 5/6 criteria pass, criterion 4 held open pending real dispatch volume |
| T-24 Exception Engine + Console | ✅ Built + applied to production 2026-08-29, shadow mode | No new UI — existing Exception Detection Engine + Alert Center is the console; `lib/exceptions/bridge.ts`, `exception_classification_rules`, `exception-bridge` cron; 7/9 criteria pass, 2 held open pending real incidents |
| T-25 Risk & Fraud Scoring | ✅ Built + applied to production 2026-08-29, shadow mode | `lib/risk/`, `payer_registry`/`transaction_halts`/`carrier_banking_details`; 7/7 criteria pass (criterion 1 on seeded signals per spec allowance) |
| T-26 Document Automation | ✅ Built + applied to production 2026-08-29, shadow mode | `lib/documents/rate-con-terms.ts`, document lifecycle triggers; 7/7 pass. **Phase 2 module set complete, but Phase 2's exit gate (100 consecutive ≥80% zero-touch loads) is NOT met** |
| T-27 Finance Orchestration | ✅ Built + applied to production, shadow mode | `lib/finance/`, migration 057, sandbox-only eCapital/Stripe/Persona adapters; 7/7 pass as of 2026-08-31 |
| T-28 Customer OS & Onboarding | ✅ Built + applied to production 2026-08-31, shadow mode | `lib/tenants/provision.ts` + `onboarding-session.ts`, `app/api/tenant-onboarding/*`, migration 058; 5/5 pass; pushed to `origin/master` |
| T-30 Contract Freight Intake | 🟡 **Merged to `master` 2026-10-09 (Tasks 1–11); migration 059 NOT applied; finalize cron held** | Verified only on Neon `t30-verify`. **Migration 059 NOT applied to production**; merged 2026-10-09 (`2bb2ba7`). Criteria 1–5, 7 PASS on `t30-verify`; criterion 6 PASS with a stated limit; the real-inbound-email half is OPEN (E2-04 IMAP poller has never run against a real mailbox, no credentials). Full-suite regression: 13 failures, 1 attributable to T-30 test-hygiene (see tracker). Exit gate NOT met (needs Patrice's end-to-end fixture review). |
| T-29 Enterprise Control Plane & White-label | Not started | Phases 5–6; gated on Phase 4 exit + counsel review. The only module with no code at all. |

**The gates are still unmet.** Master PRD §9's Engine 2 → Engine 3 handoff gate (Pilot 1 green, real call volume, Retell webhook verified on real calls, one official load-board API off stubs) has not been met; neither has Phase 2's own exit gate. T-20–T-28 exist in production as shadow-mode observers whose "held open" acceptance criteria all wait on real dispatch/call volume. Building T-29 before those gates clear would be a further exception that needs the same explicit authorization T-20–T-28 had.

**Read `wave1.md` (this directory) before touching T-17/T-18/T-19 code**, and each shipped module's own completion-tracker entry (`docs/superpowers/plans/completion.md`) before touching T-20–T-30 — every one of them documents a real schema-reality correction vs. its base spec (tenant_id BIGINT vs INTEGER, TEXT-vs-INTEGER PK mismatches, a `timestamptz`/`timestamp` cast bug in T-23, tenant-isolation IDORs in T-22/T-23/T-26/T-27, test-row leaks in T-28) that a future session would otherwise re-hit. The implementation plans under `MyraTMS/docs/superpowers/plans/` are sequencing documents — their checkboxes are never ticked; the tracker is the truth. `docs/superpowers/plans/completion.md` is the living, task-by-task tracker; update it as new modules land, don't batch. **T-19's `evaluatePolicy()` still has no caller** — the three-point policy enforcement (Qualifier/Compiler/Dispatcher) the master PRD requires is unbuilt.

## The Authoritative Document

**`E3-00_Engine3_Master_PRD.md`** is the single source of truth for vision, tenant model, autonomy boundaries, phase gates, and the metric system — read it directly rather than a paraphrase here. It is deliberately not a build spec — each module has its own child spec (T-17 onward) with acceptance criteria and a gate, front-matter `depends_on`/`referenced_by`. When handed build work here, work from one child spec at a time, never the master PRD alone (§12, §15).

## Non-negotiable principles (master PRD §3) — the ones that constrain every session here

1. **Pilot 1 is the only hard dependency.** Nothing in Engine 3 touches the live call path, the Retell agents, or the `pipeline_loads` stage machine's write path until Pilot 1 is green (§9 handoff gate below). T-17's triggers exist precisely so this holds — see "derive, don't instrument" below.
2. **Extend, never rewrite.** Engine 2's workers are wrapped as callable services, not duplicated.
3. **Portable by construction.** Typed interface, env-only config, no host-specific coupling.
4. **Orchestrate finance, never own it.** No native ledger/AR/AP — eCapital, Stripe, Persona, accounting SaaS via adapters.
5. **Every agent acts inside an authority envelope** (T-18) — no agent decides unbounded.
6. **Policy belongs to the tenant, not the platform** (T-19) — enforced at Qualifier, Compiler, and Dispatcher (three points, not one — see risk E3-R2).
7. **Instrumented from day one** (T-17) — every event is a structured record.
8. **Lean, defensible numbers** — metrics measured, never modelled, when presented externally.

## The Engine 2 → Engine 3 handoff gate (master PRD §9)

Phase 2 (T-20 through T-26) does not start until ALL of: Pilot 1 complete with all gates reported · real loads scored end-to-end against a real counterparty · Retell webhook verifier/ordering confirmed on real calls · cost-per-call/connect-rate/book-rate/gross-margin on the operator screen · concurrency-ramp green-light criteria signed off · at least one official load-board API client off stubs.

**Phase 1 (T-17/T-18/T-19) was explicitly exempt from this gate** and ran in parallel with Pilot 1 — see T-17's "derive, don't instrument" decision below for the mechanism that made that safe. **T-20 through T-28 were then built ahead of the gate anyway**, each at Patrice's explicit direction, each strictly shadow-mode and read-only against the live call path (the only live-path edit in all of Engine 3 is T-30's one-line additive `stages.ts` transition). The gate itself remains unmet as of 2026-10-07 — Engine 2 is still in shadow drain with one live call ever placed.

### T-17 design decision worth preserving: derive, don't instrument

T-17 populates `events` via **PostgreSQL triggers on tables Engine 2 already writes**, not `emitEvent()` calls inside `base-worker.ts` or any live-call-path file. A trigger is a database object, not an application code change — it cannot touch `voice-worker.ts`, `retell-webhook.ts`, or `compiler-worker.ts` while Pilot 1 is live. Real-time application-level event emission is a deferred fast-follow, gated on Pilot 1 passing.

## Tenant model (master PRD §4) — how it actually landed

Rollout order: **T1** Myra Logistics (reference implementation) → **T2** external trucking companies/brokerages → **T3** Penda & Co acquired operating companies. Tenant types get default policy for load-source rules, dispatch-agent on/off, negotiation direction — versioned per tenant, enforced at three points (never collapse to one — that's risk E3-R2, double-brokering).

T-19 shipped this against the **real** `tenants` table (which already existed from MyraTMS's own multi-tenant work, migration `027`) rather than the base spec's assumed fresh schema — see `wave1.md` §2 for exactly what changed and why. `freight_business_type` (broker/dispatcher/carrier/acquired_opco) is the new column driving policy templates; it is a different axis from `tenants.type` (platform/billing relationship), which pre-dates Engine 3 entirely.

## Module & child-spec index (master PRD §7, §12)

| ID | Title | Phase | Spec says depends on | Actual (2026-10-07) |
|---|---|---|---|---|
| T-17 | Event & Data Layer | 1 | — | ✅ production |
| T-18 | Agent Runtime & Governance | 1 | T-17 | ✅ production |
| T-19 | Tenant & Policy Model | 1 | T-18 | ✅ production (`evaluatePolicy()` called by the Qualifier only, shadow) |
| T-20 | Carrier Intelligence & Myra Carrier Score | 2 | handoff gate | ✅ production, shadow |
| T-21 | Pricing Engine | 2 | handoff gate | ✅ production, shadow |
| T-22 | Negotiation Service (bidirectional) | 2 | T-20, T-21 | ✅ production, shadow |
| T-23 | Dispatch & Load Lifecycle Monitor | 2 | T-22 | ✅ production, shadow |
| T-24 | Exception Engine + Human Escalation Console | 2 | T-23 | ✅ production, shadow |
| T-25 | Risk & Fraud Scoring | 2 | T-24 | ✅ production, shadow |
| T-26 | Document Automation | 2 | T-25 | ✅ production, shadow |
| T-27 | Finance Orchestration | 3 | Phase 2 exit | ✅ production, shadow (sandbox adapters) |
| T-28 | Customer OS & Onboarding | 4 | Phase 3 exit | ✅ production, shadow |
| T-30 | Contract Freight Intake | 4 | Phase 3 exit | 🟡 merged 2026-10-09; migration 059 unapplied; cron held |
| T-29 | Enterprise Control Plane & White-label | 5–6 | Phase 4 exit, counsel review | ⬜ not started |

Build order (§15): `T-17 → T-18 → T-19` (done) → handoff gate (**not met, bypassed by explicit direction**) → `T-20 + T-21 → T-22 → T-23 → T-24 → T-25 → T-26` (done) → `T-27` (done) → `(T-28 + T-30)` (T-28 done, T-30 merged 2026-10-09, not live) → `T-29`.

Full architecture diagram, the L1/L2/L3 autonomy table, the phase-exit-gate table, and the metric → valuation-multiple map all live in the master PRD (§5, §6, §8, §10) — read them there rather than a copy here; they don't change often enough to justify duplicating and they're one file away.

## Risk register (master PRD §14) — the two worth knowing before touching anything

**E3-R1** (Engine 3 bleeding into the live call path during Pilot 1) — mitigated by Phase 1 modules being read-only/derived consumers, separate deploy targets, and a review gate on any PR touching `voice-worker`/`retell-webhook`/`compiler-worker`. **E3-R2** (tenant policy bypass / double-brokering) — mitigated by enforcing policy at three points (Qualifier, Compiler, Dispatcher), never one. Full table (E3-R1–R7) is in the PRD.
