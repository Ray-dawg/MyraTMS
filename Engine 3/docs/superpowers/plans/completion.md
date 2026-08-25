# Engine 3 — Implementation Completion Tracker

> Tracks module-level progress through Engine 3's Phase 1–6 build order (master PRD `E3-00_Engine3_Master_PRD.md` §15). Always update this file when a task or module finishes — do not batch updates.

**Master PRD:** [E3-00_Engine3_Master_PRD.md](../../../E3-00_Engine3_Master_PRD.md)
**Started:** 2026-08-24
**Last updated:** 2026-08-24 (T-18 shipped to production)
**Status:** Phase 1 (Instrument) in progress — T-17 and T-18 both shipped to production. T-19 not started.

## How to use this file

- Mark a task done by changing `- [ ]` to `- [x]` and adding `(done YYYY-MM-DD)` after the title.
- Bump **Last updated** at the top whenever this file changes.
- If a task is partially done or blocked, note it inline: `(in progress — blocked on <reason>)`.
- Each module (T-17, T-18, ...) gets its own section. Link to that module's design doc and implementation plan under `docs/superpowers/specs/` and `docs/superpowers/plans/` in `MyraTMS/` (code lives there, not here — see `Engine 3/CLAUDE.md`).
- Log real bugs found during verification inline, not just the happy-path task list — that's the part future sessions most need to know about.

---

## Phase 1 — Instrument (T-17, T-18, T-19)

Exit gate (master PRD §8): every Engine 2 event emitted to the event layer; one agent running under a governance envelope; Myra tenant row exists, all loads carry `tenant_id`.

### T-17 — Event & Data Layer

**Spec:** [T17_Event_Data_Layer.md](../../../T17_Event_Data_Layer.md)
**Design doc:** `MyraTMS/docs/superpowers/specs/2026-08-24-t17-event-data-layer-design.md`
**Implementation plan:** `MyraTMS/docs/superpowers/plans/2026-08-24-t17-event-data-layer.md`
**Status:** ✅ **DONE — shipped to production 2026-08-24**

- [x] Migration `033-event-data-layer.sql` — `events` table, `fn_insert_event`/`fn_stage_event_type` helpers, 5 exception-safe triggers (`pipeline_loads`, `agent_calls`, `agent_jobs`, `consent_log`, `scraper_runs`), 4 metric views, `agent_calls` cost-column scaffolding (done 2026-08-24)
- [x] Backfill script `scripts/t17_backfill_events.ts` — idempotent, batched (done 2026-08-24)
- [x] Read API — `GET /api/events`, `GET /api/events/:id`, `GET /api/metrics/{funnel,stage-conversion,time-in-stage,cost-per-call}`, JWT-cookie + role-gated (done 2026-08-24)
- [x] 4 test files, 19 tests, all passing (`events-triggers`, `events-views`, `events-backfill`, `events-api`) (done 2026-08-24)
- [x] All 6 acceptance criteria verified on a disposable Neon branch (`t17-verify`, deleted after production apply) (done 2026-08-24)
- [x] Applied to production: migration + backfill run, all objects verified, read API confirmed live (done 2026-08-24)
- [x] **✅ T-17 exit gate:** all acceptance criteria pass, zero live-call-path files touched, worker test suite regressions diagnosed and resolved (done 2026-08-24)

**Bugs found and fixed during verification** (the acceptance-criteria tests catching real defects, not passing on the first try):
1. `fn_insert_event`'s `p_occurred_at` is `TIMESTAMP`, but `COALESCE(col, CURRENT_TIMESTAMP)` resolves to `timestamptz` — silently swallowed by the required exception handlers, so every UPDATE-triggered event silently failed to insert. Fixed: `LOCALTIMESTAMP` everywhere.
2. `UNIQUE (derived_from_table, derived_from_id, event_type)` assumed one event per source row per type, but `load.stage_changed` fires once per transition — a load's second transition collided with its first. Fixed: added `occurred_at` to the key.
3. `events.pipeline_load_id` had no `ON DELETE` behavior, breaking every existing pipeline test's fixture cleanup once triggers existed. Confirmed `pipeline_loads` is never deleted in production code (only test/ops scripts). Fixed: `ON DELETE CASCADE`.

**Non-bugs diagnosed during acceptance criterion 4 (zero regressions):** a `qualifier.test.ts` queue-count mismatch was leftover Redis state from an earlier run that crashed mid-suite on bug #3 (resolved on a clean run); a `ranker.test.ts` 30s timeout was proven — by reproducing the exact triggering UPDATE directly via SQL and getting an instant result — to be the matching engine doing per-carrier DB round-trips against this branch's 207 real production-forked carriers, unrelated to the trigger.

---

### T-18 — Agent Runtime & Governance

**Spec:** [T18_Agent_Runtime_Governance.md](../../../T18_Agent_Runtime_Governance.md)
**Design doc:** `MyraTMS/docs/superpowers/specs/2026-08-24-t18-agent-runtime-governance-design.md`
**Implementation plan:** `MyraTMS/docs/superpowers/plans/2026-08-24-t18-agent-runtime-governance.md`
**Status:** ✅ **DONE — shipped to production 2026-08-24**

- [x] Design doc — traced `AUTO_BOOK_PROFIT_THRESHOLD` and found it's not wired into any real decision path today (aspirational parity only, unlike the other 3 kill-switch env vars); split `evaluateAuthority()` into a pure `applyEnvelope()` core + thin DB wrapper for fast unit testing; `lib/governance/` chosen as the new directory (done 2026-08-24)
- [x] Implementation plan — 12 tasks. Self-review caught and fixed a dead variable in a test and a tenant-scoping gap in the envelope POST route (done 2026-08-24)
- [x] Task 1: Neon verification branch `t18-verify` (`br-young-haze-aii2n2en`) (done 2026-08-24)
- [x] Task 2: Migration `034-agent-runtime-governance.sql` — `agents`, `authority_envelopes`, `authority_evaluations`, `escalations` (done 2026-08-24)
- [x] Task 3: Applied + verified on branch, idempotent re-apply confirmed (done 2026-08-24)
- [x] Task 4: Shared governance types (done 2026-08-24)
- [x] Task 5: Pure `applyEnvelope()` core + 24 unit test scenarios, all passing on first run (acceptance criterion 3) (done 2026-08-24)
- [x] Task 6: `evaluateAuthority()` DB wrapper + 4 integration tests, all passing on first run (done 2026-08-24)
- [x] Task 7: Seed script — 10 agents, 8 default envelopes from **real** env values (`PIPELINE_ENABLED=true`, `SCANNER_ENABLED=false`, `MAX_CONCURRENT_CALLS=25`, `AUTO_BOOK_PROFIT_THRESHOLD=999999`) (acceptance criteria 1, 2) (done 2026-08-24)
- [x] Task 8: Replay harness (acceptance criterion 4) — 0 `call.initiated` events exist on this branch (shadow-drain mode never placed real calls), so 0 processed / 0 errors is the correct, honest result (done 2026-08-24)
- [x] Task 9: Disagreement report (acceptance criterion 5) — 0 `load.escalated` events exist on this branch (same root cause as Task 8); script correctly reports "no escalated loads found" rather than a fabricated rate. **Re-run this once real Pilot 1 calls exist** — that's when the measurement becomes meaningful (done 2026-08-24)
- [x] Task 10: 5 API endpoints + 7 tests, all passing (acceptance criterion 7) (done 2026-08-24)
- [x] Task 11: Full regression suite — 16 test files, 68 tests, all green (T-16 pipeline + T-17 events + T-18 governance), excluding the pre-existing `ranker.test.ts` matching-engine slowness already documented under T-17 (acceptance criterion 6) (done 2026-08-24)
- [x] Task 12: Final acceptance checklist — all 7 criteria pass (done 2026-08-24)

**Bugs found and fixed during verification:**
1. `authority_envelopes.agent_id` and `authority_evaluations.agent_id` had no `ON DELETE` behavior, breaking test cleanup once envelope/evaluation rows existed. `agents` is never deleted by live code (only deactivated via `status`). Fixed: `ON DELETE CASCADE` on both.
2. The `escalations` PATCH route's SQL reused the `$1` placeholder across a plain assignment (`status = $1`) and an `IN` list (`CASE WHEN $1 IN (...)`) in the same statement — Neon's serverless driver can't type-infer that consistently (`inconsistent types deduced for parameter $1`). Fixed: moved the `resolved_at` logic into JS instead of a SQL `CASE WHEN`.
3. Found via the **full regression suite**, not T-18's own tests in isolation: `authority_evaluations.source_event_id` (FK to `events`) also had no cascade. A T-18 test's idempotency fixture happened to reference an `events` row that a T-17 test's own cleanup later tried to delete, blocking it. Same reasoning as bug #1 — `events` is only ever deleted by test/ops code. Fixed: `ON DELETE CASCADE`.
4. Execution mistake (not a code bug): the seed script's first run used `pnpm tsx` with only `DATABASE_URL` set, and unlike `vitest` (which auto-loads `.env.local`), a raw `tsx` invocation does not — so all four kill-switch env vars silently fell back to their hardcoded defaults instead of the real values. Caught by checking the printed kill-switch table against known `.env.local` values; re-ran with all four vars explicitly exported.

**Applied to production 2026-08-24:** migration + seed script (real env values confirmed: `MAX_CONCURRENT_CALLS=25` in production, not a fallback) + replay harness + disagreement report all run, all objects verified, API confirmed live (7/7 tests pass against production, including fixture cleanup exercising the cascade fixes). Both the replay harness and disagreement report show 0 activity in production too — same honest limitation as on the branch, not a bug: no real Retell calls have been placed yet.

---

### T-19 — Tenant & Policy Model

**Spec:** [T19_Tenant_Policy_Model.md](../../../T19_Tenant_Policy_Model.md)
**Status:** Not started (depends on T-17, T-18)

---

## Phase 2 — Operationalize (T-20–T-26)

Blocked on the Engine 2 → Engine 3 handoff gate (master PRD §9) AND Phase 1 exit. Not started.

## Phase 3 — Financialize (T-27)

Not started.

## Phase 4 — Commercialize (T-28, T-30)

Not started.

## Phase 5 — Platformize (T-29 core)

Not started.

## Phase 6 — White-label (T-29 branding)

Not started.
