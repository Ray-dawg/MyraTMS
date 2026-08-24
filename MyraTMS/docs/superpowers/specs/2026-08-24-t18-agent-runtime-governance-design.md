# T-18 Agent Runtime & Governance — Implementation Design

**Date:** 2026-08-24
**Base spec:** `Engine 3/T18_Agent_Runtime_Governance.md` (authoritative for schema, the `evaluateAuthority()` contract, the worked-example envelope, acceptance criteria, and the gate). This document only records the decisions needed to reconcile that spec with the real MyraTMS codebase and to scope this build session — it does not restate anything the base spec already fixes.

## Why this document exists

The base spec's kill-switch mapping table (§5.1) and seed data (§4.1, §5) require real current values from the codebase, not invented ones, and the spec leaves the internal structure of `evaluateAuthority()` and the file layout open. This doc closes those gaps.

## Codebase reconciliation

Checked against the live MyraTMS codebase on 2026-08-24:

| Base spec assumption | Reality | Resolution |
|---|---|---|
| Four env vars gate real behavior: `PIPELINE_ENABLED`, `SCANNER_ENABLED`, `MAX_CONCURRENT_CALLS`, `AUTO_BOOK_PROFIT_THRESHOLD` | Current `.env.local` values: `PIPELINE_ENABLED=true`, `SCANNER_ENABLED=false`, `MAX_CONCURRENT_CALLS=25`, `AUTO_BOOK_PROFIT_THRESHOLD=999999`. First three are genuinely read and gate real code paths (`scripts/run-workers.ts`, `lib/workers/voice-worker.ts`, `lib/workers/compiler-worker.ts`). `AUTO_BOOK_PROFIT_THRESHOLD` is only logged at worker-host startup (`scripts/run-workers.ts:92`) — traced the real `auto_book_eligible` decision to `lib/pipeline/retell-webhook.ts:374` (`callResult.profit >= minMargin`, where `minMargin` comes from `brief.rates.minMargin`, a per-negotiation value) and confirmed the env var is never read there or anywhere else in the decision path | Seed script reads all four from `process.env` at seed time (per spec instruction, not hardcoded). The kill-switch mapping table (§5.1) is built with all four rows, but `AUTO_BOOK_PROFIT_THRESHOLD`'s row is annotated as **aspirational parity, not a live gate today** — this is the honest answer acceptance criterion 2 ("verified field-by-field against current production env var values") requires, not silence |
| Migration numbering | Next free number in `MyraTMS/scripts/` is `034` | File: `034-agent-runtime-governance.sql` |
| `lib/governance/` | Directory doesn't exist yet — and the top-level `M1/CLAUDE.md` already anticipates it ("as of this writing `MyraTMS/lib/` has no `events`, `governance`, `agents`, or `orchestrator` module") | New code lives in `lib/governance/`, matching that expectation and keeping this module separate from `lib/pipeline/` (T-18 is infrastructure *about* agents, not an Engine 2 pipeline stage) |
| `agents` table name | No collision — grepped all existing migrations | Safe to use as specified |

## Decisions

### 1. Split `evaluateAuthority()` into a pure core + a thin DB wrapper

The base spec's §6 pseudocode loads the envelope from DB as step 1, then runs permission/budget/escalation logic. Testing all of that against a live DB for ≥20 scenarios (acceptance criterion 3) would make the test suite slow and coupling-heavy for what is fundamentally pure business logic.

Resolution: `lib/governance/evaluate.ts` exports `applyEnvelope(envelope: AuthorityEnvelope, action: string, context: Record<string, unknown>): EvaluationResult` — pure, no I/O, contains permission-list checks, budget checks, and the escalation-rule walk (first-match-wins). `lib/governance/evaluate-authority.ts` exports `evaluateAuthority(input: EvaluationInput): Promise<EvaluationResult>` — the spec's exact external signature — which loads the active envelope row, calls `applyEnvelope`, writes `authority_evaluations` (and `escalations` if the decision is `escalate`), and returns the result. The ≥20 scenarios in acceptance criterion 3 target `applyEnvelope` directly; a small number of additional integration tests cover the full `evaluateAuthority()` wrapper against a live envelope row on the verification branch, mirroring how T-17 tested triggers.

This does not change the spec's external contract — `evaluateAuthority()` still has exactly the signature in §6.

### 2. Replay harness ships as a standalone idempotent script, not a live cron

The base spec's §7 allows either "poll on a schedule" or "run once against the full backfill." Acceptance criterion 4 only requires the latter. Resolution: `scripts/t18_replay_shadow_evaluation.ts` exports `runReplay(): Promise<void>`, structured like T-17's `scripts/t17_backfill_events.ts` (batched, idempotent via the `source_event_id` uniqueness the spec already specifies on `authority_evaluations`). No Vercel cron wiring in this session — that's a natural, separately-scoped follow-up once T-18's shadow judgments have been reviewed (acceptance criterion 5).

### 3. Auth pattern: same as T-17

`GET /api/agents`, envelope CRUD, `GET /api/evaluations`, `GET /api/escalations`, `PATCH /api/escalations/:id` all use `getCurrentUser` + `requireRole(user, 'admin', 'ops')`, matching every other operator route including T-17's. Write endpoints (`POST .../envelope`, `PATCH /api/escalations/:id`) additionally require an `actor` field in the body per the base spec's §8 note ("even in shadow mode, envelope changes are audited from day one") — resolved as the authenticated user's own identity (`user.userId`) rather than a client-supplied free-text field, so the audit trail can't be spoofed by whoever holds the session.

### 4. Session scope: branch-verify, not production-apply (same as T-17)

This module is purely additive (new tables only; no triggers on `pipeline_loads`/`agent_calls`/etc. this time — the replay harness reads `events` via polling, not via a DB trigger), so the blast radius of a mistake is lower than T-17's. The same discipline still applies: build everything, verify on a disposable Neon branch, and stop short of production. Patrice reviews and applies themselves, same two-command pattern as T-17.

## Explicitly unchanged from the base spec

The 4-table data model (§4), the worked-example envelope JSON (§5), the `evaluateAuthority()` external contract (§6), the write-boundary rules (§9 — only `authority_evaluations`/`escalations` may be inserted into, no agent may modify its own envelope), the portability notes (§10), and all 7 acceptance criteria (§11) — the base spec is authoritative on all of these.

**Explicitly out of scope, per the base spec's own instruction:** wiring `evaluateAuthority()` into `base-worker.ts`, `voice-worker.ts`, `dispatcher-worker.ts`, or `compiler-worker.ts` (T-18b); the Human Escalation Console UI (T-24); real spend-limit enforcement (T-27).
