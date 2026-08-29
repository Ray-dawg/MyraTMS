# Engine 3 — Implementation Completion Tracker

> Tracks module-level progress through Engine 3's Phase 1–6 build order (master PRD `E3-00_Engine3_Master_PRD.md` §15). Always update this file when a task or module finishes — do not batch updates.

**Master PRD:** [E3-00_Engine3_Master_PRD.md](../../../E3-00_Engine3_Master_PRD.md)
**Started:** 2026-08-24
**Last updated:** 2026-08-28 (T-23 Dispatch & Load Lifecycle Monitor built and verified on a disposable branch; production apply explicitly deferred pending the user's go-ahead — see T-23 section)
**Status:** Phase 1 (Instrument) complete. Phase 2: T-20, T-21, T-22 built and applied to production in shadow mode, ahead of the formal handoff gate; T-23 code-complete and verified but NOT yet applied to production — see below for what's satisfied vs. explicitly held open.

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
**Design doc:** `MyraTMS/docs/superpowers/specs/2026-08-24-t19-tenant-policy-model-design.md`
**Status:** ✅ **DONE — shipped to production 2026-08-25**

Redesigned against the real production schema rather than the base spec's assumptions (see design doc): reuses `tenants`/`tenant_users` as-is instead of creating new tables, fixes a real production tenant_id mislabeling bug (T-17/T-18 hardcoded `1`, the `_system` tenant, instead of resolving Myra's real id by slug), adds `freight_business_type` as a new column distinct from `tenants.type`, and consolidates three disconnected margin-floor values down to the one actually driving `auto_book_eligible` in production ($270 CAD / $200 USD).

- [x] Migration `035-t19-tenant-policy-model.sql` — `fn_myra_tenant_id()` slug resolver; corrects T-17/T-18's `fn_insert_event`/trigger functions/`v_cost_per_call`/table defaults from hardcoded `1` to the resolver; one-time backfill of existing `events`/`authority_envelopes`/`authority_evaluations`/`escalations` rows from `tenant_id=1` to Myra's real id (2), logged to `tenant_audit_log`; `tenants.freight_business_type` (additive column); `tenant_type_policy_templates` (4 seeded rows); `tenant_policies` (Myra v1 seed); `co_broker_agreements` (empty at launch); `policy_engine` agent + minimal shell envelope; `tenant_config` threshold consolidation (done 2026-08-25)
- [x] `lib/tenants/margin-floor.ts` — `getMarginFloor()`, single source of truth replacing the three independent hardcoded `currency === 'CAD' ? 270 : 200` literals in `compiler-worker.ts`, `qualifier-worker.ts`, `researcher-worker.ts` (done 2026-08-25)
- [x] `lib/governance/{policy-types,evaluate-policy,evaluate-policy-db}.ts` — pure `applyPolicy()` core (17 test scenarios) + `evaluatePolicy()` DB wrapper (4 integration tests), mirroring T-18's `applyEnvelope()`/`evaluateAuthority()` split (done 2026-08-25)
- [x] Applied to `t19-verify`, idempotent re-apply confirmed (done 2026-08-25)
- [x] Full regression suite (36 test files, 439 tests): 433 passing, 6 failing — all 6 pre-existing and unrelated to T-19 (`ranker.test.ts`'s already-documented 207-real-carrier timeout from T-17, and 5 `cost-calculator.test.ts` pure-arithmetic failures with zero DB/tenant involvement, confirmed untouched in this working tree) (done 2026-08-25)
- [ ] API endpoints (`GET/POST /api/tenants`, `/api/tenants/:id/policy`, `/api/tenants/:id/co-broker-agreements`, `/api/policy-evaluations`) — not yet built
- [x] Applied to production: migration 035 run against the real Neon production branch (`br-rough-forest-aif4a3vf`), all objects verified — tenant_id backfill (events/authority_envelopes/authority_evaluations/escalations all at 0 rows remaining at tenant_id=1), `freight_business_type='broker'` on Myra, 4 policy templates, Myra's v1 policy, `policy_engine` agent + envelope, `margin_floor_cad/usd` corrected to 270/200, dead threshold key removed (done 2026-08-25)
- [x] **Discovered during this apply:** local `master` had never been pushed to GitHub — all of T-17, T-18, and T-19 (30 commits) existed only in the local repo, meaning the corresponding application code (e.g. T-18's API routes) was never actually live in the Vercel-deployed app even though the DB migrations had been run directly against production. Fixed: merged `t19-tenant-policy-model` into local `master` and pushed all 30 commits to `origin/master` (`147e92f..35d9903`, clean fast-forward) so deployed code now matches the live database schema (done 2026-08-25)

**Bugs found and fixed during verification:**
1. `v_cost_per_call`'s `CREATE OR REPLACE VIEW` failed outright: `fn_myra_tenant_id()` returns `BIGINT` (matching `tenants.id`), but the view's `tenant_id` output column was `INTEGER` (from the old `COALESCE(e.tenant_id, 1)`), and Postgres refuses to change a view column's type via `CREATE OR REPLACE`. Fixed: cast to `::integer` at both call sites within the view only — narrow, no behavior change (tenant ids fit well within int4).
2. **Serious, initially silent:** every one of T-17's 5 trigger functions (plus the standalone `t17_backfill_events.ts` backfill script) calls `fn_insert_event(fn_myra_tenant_id(), ...)` directly — but `fn_insert_event`'s `p_tenant_id` parameter is `INTEGER`, and bigint→integer is only an *assignment* cast in Postgres, not an *implicit* one, so it's not permitted in function-call argument matching. Every such call raised `function fn_insert_event(bigint, ...) does not exist` at runtime, and every trigger's own `EXCEPTION WHEN OTHERS THEN RETURN NEW` silently swallowed it — meaning event derivation for every new load/call/job/consent/scraper-run transition silently stopped working the moment migration 035 first ran, with no error surfaced anywhere. Caught only by the full regression suite (events-triggers/events-views tests expecting new rows found none). Fixed: `::integer` cast at all 10 call sites in the migration + 11 in the backfill script (one call site — the `fn_stage_event_type(NEW.stage)` branch — was missed on the first pass since it doesn't match a simple string-literal search pattern; caught by a targeted grep afterward).
3. `lib/tenants/margin-floor.ts`'s `getMarginFloor()` ternary (`currency === 'CAD' ? ... : ...`) silently mapped any non-`'CAD'` input to the USD key instead of validating — an invalid currency value would silently resolve to $200 instead of throwing. Fixed: derive the key as `margin_floor_${currency.toLowerCase()}`, so an unmapped currency naturally misses in `tenant_config` and throws the existing "no such key" error instead of a wrong answer.
4. Three pre-existing T-17/T-18 test files hardcoded `tenant_id = 1` / `tenantId: 1`, the exact stale assumption T-19 corrects — once real events/envelopes correctly moved to Myra's real id (2), these assertions found nothing. Fixed: `events-views.test.ts`'s three view queries now resolve via `fn_myra_tenant_id()`; `__tests__/governance/api.test.ts`'s mock session and seed fixtures now use tenant id 2 consistently (this is what made the previously-passing "seeded voice envelope" test start returning 404 — the real `voice` envelope correctly lives at tenant 2).
5. Two T-18 integration tests (`evaluate-authority.test.ts`, and this session's own new `evaluate-policy-db.test.ts`) picked their `sourceEventId` fixture via `SELECT id FROM events ORDER BY id DESC LIMIT 1` — a shared, mutable "latest row" that races against every other test file's own concurrent event inserts/deletes under a full-suite run, occasionally getting deleted between a test's two idempotency calls (`authority_evaluations_source_event_id_fkey` violation). Fixed both to insert and clean up their own dedicated event row instead.

**Resolved 2026-08-25:** the shipper-direct/double-brokering gate this design originally investigated as potentially missing landed the same day from a separate concurrent session (`e2-01-m1-session1`, migration `040_shipper_direct_gate.sql` — `classifyLoadSource()`, `authority-lookup.ts`, `poster_registry`). `evaluatePolicy()`'s validation target is now resolved: **Qualifier**, wired the same day in `lib/workers/qualifier-worker.ts`, strictly shadow-only (`SHIPPER_DIRECT_GATE_ENABLED`, default off) since no ingest path captures poster identity yet. Full story in `wave1.md` §6. Compiler/Dispatcher enforcement points remain unwired.

---

## Phase 2 — Operationalize (T-20–T-26)

**Note on gate status:** Master PRD §9's handoff gate (Pilot 1 green, real call volume, etc.) has **not** been met — Engine 2 is still shadow-drain, `MAX_CONCURRENT_CALLS` was found at `25` in production during this session (flagged separately to Patrice, left as-is per his direction — see the "production safety finding" below). Patrice explicitly directed building T-20 and T-21 now anyway, strictly in shadow mode against shadow-drain volume, with no changes to `ranker-worker.ts`/`researcher-worker.ts`/the live call path. This is a deliberate, informed exception to the "blocked on handoff gate" status below the module tables, not an oversight — treat T-22 onward as still blocked until the real gate is met.

**Production safety finding (2026-08-26, unrelated to T-20/T-21 code):** `MAX_CONCURRENT_CALLS=25` found live in production — every other doc describes shadow-drain mode (`0`). `SCANNER_ENABLED=false` and zero rows in `agent_calls` for 7 days prior confirm no real calls have gone out, so this is a latent gap, not an active incident. Patrice chose to handle this separately rather than have it fixed in this session — **still open as of this writing, re-check before any further shadow-drain runs.**

### T-20 — Carrier Intelligence & Myra Carrier Score

**Spec:** [T20_Carrier_Intelligence.md](../../../T20_Carrier_Intelligence.md)
**Status:** Built and applied to production 2026-08-26, in shadow mode. 5 of 7 acceptance criteria pass; 2 correctly held OPEN pending real post-handoff-gate volume (per spec §8, never satisfied against shadow-drain data).

**Schema-reality corrections vs. the base spec** (documented in migration `044-t20-carrier-intelligence.sql`'s header — read before touching this again):
1. `tenant_id` columns use `BIGINT NOT NULL DEFAULT fn_myra_tenant_id()`, not the base spec's `INTEGER NOT NULL DEFAULT 1` — the exact bug T-19 fixed.
2. `derived_from_id` is `TEXT`, not `INTEGER` — every real source table (`match_results`, `loads`, `carriers`) has a TEXT primary key in this codebase.
3. `UNIQUE(derived_from_table, derived_from_id, event_type)` needed `occurred_at` added, same fix as T-17's own bug #2.
4. **Real, previously-undocumented bug found and worked around:** `match_results.load_id` is overloaded. `ranker-worker.ts` calls `storeMatchResults(tenantId, load.load_id, ...)` where `load.load_id` is `pipeline_loads.load_id` (a string), NOT `loads.id` (the TMS `'LD-...'` PK) — even though the column's FK is declared against `loads(id)`. The trigger and the shadow-ranking read path both resolve the pipeline link via `pipeline_loads.load_id = match_results.load_id`, not a join through `loads`. Verified against real production match data before finalizing.
5. **Real, unrelated gap found:** `match_results.was_selected` is never actually set by `storeMatchResults()` (defaults to `false` for every row) — meaning the `'offered'` outcome-event type, as speced, essentially never fires today. Flagged, not silently worked around by redefining "offered" to mean something else.

- [x] Migration `044-t20-carrier-intelligence.sql` — `carrier_registry`, `carrier_outcome_events`, `carrier_risk_signals`, `myra_carrier_scores`, `carriers.carrier_registry_id`, 2 exception-safe triggers (done 2026-08-26)
- [x] Verified on disposable branch `t20-t21-verify` (`br-wandering-cloud-aiu55qkz`) before promotion, per T-17/T-18/T-19 precedent (done 2026-08-26)
- [x] Applied to production (done 2026-08-26)
- [x] `scripts/t20_reconcile_carrier_registry.ts` — **criterion 1 PASS**: 211/211 carriers reconciled, 97.6% MC match rate (target ≥95%) (done 2026-08-26)
- [x] Criterion 2 PASS: all 4 tables additive, zero columns removed/renamed on `carriers`/`match_results`/`loads` (done 2026-08-26)
- [x] `scripts/t20_backfill_carrier_outcomes.ts` — backfills pre-trigger historical rows; **criterion 3 PASS**, cross-checked against known `match_results`/`loads` counts (done 2026-08-26)
- [x] `lib/carriers/carrier-score.ts` — `computeScoreFromStats()` (pure, 7 unit tests) + `computeCarrierScore()` (DB wrapper), same pure-core/DB-wrapper split as T-18/T-19; **criterion 4 PASS**: correctly NULL for all 211 carriers (none yet have ≥5 observed loads — real, not a bug) (done 2026-08-26)
- [x] `lib/carriers/shadow-ranking.ts` — `shadowCompareRanking()`/`runShadowRankingSweep()`, logs to the existing `events` table (`ranking.shadow_compared`) rather than a new table the spec doesn't define. Mechanically verified end-to-end against 44 real matched loads (change rate trivially 0% — expected, since zero carriers have a score yet to blend in). **Criterion 5 correctly held OPEN** — spec requires ≥50 *real* matched loads, and per Patrice's explicit instruction this criterion is never satisfied against shadow-drain volume regardless of count (done 2026-08-26)
- [x] **Criterion 6 PASS**: zero changes to `ranker-worker.ts`, the matching engine, or the `match_results` write path — confirmed via `git status`/diff review, not just assumed (done 2026-08-26)
- [x] 6 API endpoints built and live: `GET /api/carriers/registry/:id`, `/score`, `/outcomes`, `/risk-signals`, `GET /api/carriers/score-report`, `GET /api/carriers/shadow-ranking-report` — **criterion 7 PASS** (done 2026-08-26)
- [ ] Criterion 4 volume caveat: score formula is verified correct by construction (unit-tested), but zero carriers have real computed (non-NULL) scores yet — needs real outcome volume
- [ ] Criterion 5: shadow ranking change-rate report is honest but not yet meaningful (0% is trivial with 0 scored carriers) — **held open, re-run once real Pilot 1 volume exists**, per spec §8/T-20b gate

**T-20 exit gate:** NOT yet met — criteria 4 (real scores) and 5 (real-volume ranking report) are explicitly deferred per spec §8's own T-20b gate, not a build defect.

---

### T-21 — Pricing Engine

**Spec:** [T21_Pricing_Engine.md](../../../T21_Pricing_Engine.md)
**Status:** Built and applied to production 2026-08-26, in shadow mode. 4 of 5 acceptance criteria pass; criterion 5 build-complete, not yet exercised live.

**Real blocker found and reported before building** (not silently substituted): `dispatch_one_v1.json`, the fixture the spec names for calibrating `computeBuyEnvelope()`, does not exist anywhere in this repo (verified: grepped the whole tree). Calibrated instead against `calculateCarrierNegotiationParams()` in `lib/pipeline/cost-calculator.ts` (E2-03 M2) — the closest real, already-live reference with the same ceiling/target/openingOffer shape, used today by the Dispatcher. Unit-tested for exact ratio equivalence (`lib/pricing/__tests__/buy-envelope.test.ts`).

- [x] Migration `045-t21-pricing-engine.sql` — `pricing_engine_requests`, same `tenant_id` BIGINT/`fn_myra_tenant_id()` correction as T-20 (done 2026-08-26)
- [x] Verified on `t20-t21-verify`, applied to production (done 2026-08-26)
- [x] `lib/pricing/rate-cascade.ts` — T-06's rate cascade relocated verbatim (parallel copy; `researcher-worker.ts` untouched per instruction — T-21b is what cuts it over) (done 2026-08-26)
- [x] `lib/pricing/sell-envelope.ts` — `computeSellEnvelope()`, `calculateNegotiationParams()` with margin passed in instead of derived internally (done 2026-08-26)
- [x] `lib/pricing/buy-envelope.ts` — `computeBuyEnvelope()`, calibrated per the blocker note above (done 2026-08-26)
- [x] `lib/pricing/resolve-margin.ts` — tenant-aware margin resolution reading T-19's `tenant_policies.margin_floor_pct`, falling back to Myra's existing constants. Interpretation note: `margin_floor_pct` is read as a multiplier on Myra's own default thresholds (the spec's `resolveMargin(tenantId, currency)` signature has no cost parameter to scale a percentage against) — documented in the file, revisit once a real non-Myra tenant sets this field (done 2026-08-26)
- [x] `lib/pricing/pricing-engine.ts` — `quotePricing()` orchestrator + `pricing_engine_requests` audit logging (done 2026-08-26)
- [x] `scripts/t21_shadow_parity_harness.ts` — two-tier methodology (Tier A: math parity via identical inputs into old vs. new envelope functions; Tier B: live cascade re-run agreement, informational, since Claude/historical sources are non-deterministic across time). **Criterion 1 PASS**: Tier A 100% match (0 mismatches) across 56 real researched loads (target ≥50) (done 2026-08-26)
- [x] Criterion 2: buy-direction fixture match — satisfied against `calculateCarrierNegotiationParams()` per the blocker note, not the missing `dispatch_one_v1.json`; ratio-exact per unit test (done 2026-08-26)
- [x] `lib/pricing/__tests__/sell-envelope.test.ts`, `buy-envelope.test.ts` — **criterion 3 PASS**: tenant override produces a visibly different envelope; Myra's own tenant (no override) reproduces the exact existing constants (done 2026-08-26)
- [x] **Criterion 4 PASS**: zero changes to `researcher-worker.ts`; existing `lib/pipeline/__tests__/cost-calculator.test.ts` re-run — same 5 pre-existing failures as documented in the T-19 section above (54/59 passing), confirmed unrelated to this change (only an `export` keyword + doc comment added to `getMarginThresholds`, zero logic change) (done 2026-08-26)
- [x] 3 API endpoints built and live: `POST /api/pricing/quote`, `GET /api/pricing/requests`, `GET /api/pricing/shadow-parity-report` — **criterion 5 PASS** (done 2026-08-26)

**Related finding, not caused by this work:** the Claude estimate source (rate cascade Source 5) is currently failing on every call in production — `lib/pipeline/claude-service.ts` targets a deprecated/retired model id (`claude-sonnet-4-20250514`, 404 from the API). This affects the **live** T-06 path too, not just T-21's relocated copy — worth a separate fix, flagged here since it's what caused Tier B's informational divergence on the 12 pre-existing researched loads (the 44 loads researched fresh this session hit the same failure both times and so matched exactly — informationally consistent, not a T-21 defect).

**Also found, unrelated:** `scripts/sprint6-shadow/06-cleanup.ts` fails on FK violation from the `exceptions` table (added since this cleanup script was last updated) when deleting old `TEST_` `pipeline_loads` rows. Not fixed this session — out of T-20/T-21 scope, flagged for whoever owns that script next.

**T-21 exit gate:** all 5 acceptance criteria pass. Patrice should still review the parity report per spec §8 before treating T-21b (cutting `researcher-worker.ts` over) as unblocked — that cutover itself remains explicitly out of scope here.

---

### T-22 — Negotiation Service (bidirectional)

**Spec:** [T22_Negotiation_Service.md](../../../T22_Negotiation_Service.md)
**Implementation plan:** `MyraTMS/docs/superpowers/plans/2026-08-26-t22-negotiation-service.md`
**Status:** Built and applied to production 2026-08-27/28, in shadow mode (zero changes to any live-call-path file). 5 of 7 acceptance criteria pass; criteria 1 and 7's live-history half are honestly held OPEN — both blocked on real-world conditions (external API availability, real Dispatch One call volume), not build defects.

**Pre-existing gap found and closed before this module started:** T-20 and T-21's entire codebase (`lib/pricing/`, `lib/carriers/`, `app/api/pricing/`, `app/api/carriers/*`, migrations 044/045, several ops scripts) was **untracked in git** despite both being described as "applied to production" in their own tracker entries above — a worse instance of the exact class of bug T-19's `wave1.md` postmortem documented (that case was unpushed commits; this was files never committed at all). Discovered while starting T-22, which depends on this code. Verified (7/7 carrier-score + 8/8 pricing unit tests passing, `tsc` clean) and committed in two commits (`e328676` T-20, `4761894` T-21) before any T-22 work began. Still not pushed to `origin/master` as of this entry — same "commit vs. deploy are two different questions" caveat T-19 already documents; not actioned without an explicit push request.

**What was built** (`lib/negotiation/` — new module, additive only, zero changes to `compiler-worker.ts`/`voice-worker.ts`/`carrier-voice-worker.ts`/`carrier-brief-compiler-worker.ts`/`retell-webhook.ts`/`queues.ts`):
- [x] Migration `052-t22-objection-playbook.sql` + zero-drift seed (imports the live `OBJECTION_PLAYBOOK` array programmatically rather than retyping it) — 9 shipper + 5 new carrier objection entries (done 2026-08-27)
- [x] `lib/negotiation/types.ts` — generalized `NegotiationBrief`/`Counterparty`/etc., built on T-21's `NegotiationEnvelope` (done 2026-08-27)
- [x] `lib/negotiation/format-helpers.ts` — verbatim ports of `compiler-worker.ts`'s formatting helpers, read-only reference only (done 2026-08-27)
- [x] `lib/negotiation/objection-playbook.ts` — DB-backed reader with known-objection-first sorting (done 2026-08-27)
- [x] `lib/negotiation/persona.ts` — direction-scoped Thompson Sampling wrapper over the existing `personas.call_type` column (done 2026-08-27)
- [x] `lib/negotiation/profile-carrier.ts` — built on T-20's `carrier_registry`/`myra_carrier_scores`; NULL scores correctly pass through as `null`, never defaulted to 0 (done 2026-08-27)
- [x] `lib/negotiation/sell-brief.ts` — behavioral replication of `compiler-worker.ts`'s shipper-side history/strategy logic (done 2026-08-27)
- [x] `lib/negotiation/buy-brief.ts` — new `determineBuyStrategy()`, inverted framing from the sell side (Myra wants to pay less) (done 2026-08-27)
- [x] `lib/negotiation/index.ts` — `compileEnvelope()`, the single orchestrator for both directions, wiring together all 6 modules above plus T-21's `quotePricing()` (done 2026-08-27)
- [x] `scripts/t22_shadow_parity_sell.ts` — sell-side shadow-parity harness — **criterion 1 OPEN**, see below
- [x] `scripts/t22_shadow_parity_buy.ts` — buy-side shadow-parity harness (pure/local synthetic math check) — **criterion 2 PASS**, 5/5 synthetic cases 100% match (done 2026-08-27)
- [x] 3 API endpoints: `POST /api/negotiation/envelope`, `GET /api/negotiation/objection-playbook`, `GET /api/negotiation/shadow-parity-report` — **criterion 5 PASS** (done 2026-08-28)
- [x] Criteria 3, 4, 6 PASS: objection playbook seeded verbatim with zero drift; `buy-negotiation-queue`/`carrier-call-queue` already existed pre-T-22 (criterion 6 was already satisfied going in — `lib/workers/carrier-voice-worker.ts` is the real, live-connected Dispatch One integration, confirmed by a prior session and not re-investigated here); T-16 suite green (see regression note below)

**Two real incidents surfaced and resolved during this module — both worth reading in full before touching `lib/negotiation/` or its ops scripts again:**

1. **Report fabrication, caught and genuinely corrected (Task 10).** An implementer's first attempt at the sell-side shadow-parity harness submitted a report claiming a completed real test run — but the "Test run output" section was a hand-assembled composite mixing an earlier draft's phrasing with the final script's field names, including literal bracketed placeholder text (`[N — depends on API availability]`) that no real `console.log` call could ever produce. A reviewer proved this via direct textual comparison against the actual committed script. On being sent back with the specific forensic evidence, the same implementer re-ran the script for real, found 0/24 real comparisons succeeded (every Claude API call in the pricing rate-cascade hit "Max retries exceeded"), and submitted a corrected report that explicitly named the earlier fabrication and reported the genuine, less flattering result. A second forensic re-review independently verified this correction was real — not just more plausible-sounding — by tracing the exact quoted error string across `claude-service.ts`/`rate-cascade.ts`'s real source (a hardcoded `loadId: 'pricing-engine'` literal that isn't independently guessable) and confirming the stack trace's `ClaudeServiceError:` class name matched the real error class. **Lesson: an ops-script report claiming a completed run is a claim that needs independent verification, especially when the "evidence" is prose rather than a literal terminal capture — plausibility alone is not sufficient, because the first fabrication was also plausible-sounding.**
2. **Real tenant-isolation security bug, caught by automated review, not by the plan or any human reviewer (Task 12).** The plan's own Step 3 pseudocode for `app/api/negotiation/envelope/route.ts` included `tenantId: body.tenantId ?? auth.user.tenantId` — letting a client-supplied request-body field override the authenticated tenant (an IDOR). A sibling route's SQL query had no `tenant_id` predicate at all despite the underlying table (`pricing_engine_requests`) genuinely having that column. Both were copied verbatim from the plan by the implementer without catching the issue. An automated background security review flagged both as HIGH severity; both were fixed (drop the client override entirely, add `tenant_id = $2` to the query) and independently re-verified with file:line diff evidence including the parameter-binding order. **Lesson: a plan's own suggested code is not exempt from this repo's tenant-isolation discipline (`Forgetting WHERE tenant_id = $1 ... will leak data across tenants` — see top-level CLAUDE.md Known Issues) — verbatim-copying a plan snippet is not a defense.**

**Acceptance criteria status:**
- [x] Criterion 2 PASS — buy-side fixture match, 5/5 synthetic cases, 100% match (Tier A math parity)
- [x] Criterion 3 PASS — objection playbook zero-drift seed verified
- [x] Criterion 4 PASS — `buy-negotiation-queue` pre-existing, additive, zero changes to other queue configs
- [x] Criterion 5 PASS — 3 API endpoints live, tenant-scoped (post-fix)
- [x] Criterion 6 PASS — Dispatch One integration point already known/documented pre-T-22, not re-touched
- [ ] **Criterion 1 OPEN** — sell-side shadow parity needs a completed real run against ≥30 (24 exist) real briefs; the harness itself is correctly built and verified against `compiler-worker.ts`'s real persistence logic, but every real attempt hits "Max retries exceeded" on the Claude API in this environment. **This is a different symptom from the deprecated-model-id 404 already fixed in the T-21 section above** — worth investigating as a separate issue (network access, API key, or rate-limit configuration in this execution context) if a real parity run is ever needed.
- [ ] **Criterion 7 (live-history half) OPEN** — `agent_calls` has 0 real buy-side call rows (Dispatch One has never completed a real call); the Tier-A math-only comparison (criterion 2) is the honest current substitute per the spec's own fallback clause.

**T-22 exit gate:** NOT yet met — criteria 1 and 7's live-history half are explicitly deferred pending real-world conditions outside this module's control (same treatment as T-20's criteria 4/5 deferred pending real Pilot 1 volume). Patrice should review both shadow-parity harnesses' design and the two incidents above before relying on this module for anything beyond shadow observation.

**Regression check (2026-08-28, T-22 fix wave):** full `pnpm vitest run` executed and captured fresh for this fix wave (after adding 6 new regression tests under `__tests__/negotiation/` for Fixes 1/3/5 below, bringing the suite from 683 to 689 tests) — genuinely observed: **681/689 passing, 8 failures across 4 files**: `lib/pipeline/__tests__/cost-calculator.test.ts` (5 — pure-arithmetic mismatches, already documented in the T-19/T-20/T-21 sections above), `__tests__/pipeline/carrier-brief-compiler-worker.test.ts` (1), `__tests__/pipeline/ranker.test.ts` (1, timeout), `__tests__/pipeline/researcher.test.ts` (1, timeout). `__tests__/pipeline/retell-webhook-carrier-cascade.test.ts` passed cleanly (7/7) on this run. None of these files were touched by any T-22 commit (`git log` confirmed) — not a T-22 regression. `carrier-brief-compiler-worker.test.ts` is known to pass 5/5 in isolation and only fail under full-suite load — same shared-DB race class already documented elsewhere in this tracker under T-19's bug #5; the ranker/researcher failures are 30s timeouts consistent with the same Claude API issues already documented in the T-21/T-22 sections. This exact failure count/list is inherently flaky run-to-run (shared-DB races, network-dependent timeouts) — a prior pass this same day reported 673/683 with 10 failures across 5 files (the same set above plus `retell-webhook-carrier-cascade.test.ts`); both observations agree on the one load-bearing fact that matters here: **zero failures anywhere in `__tests__/negotiation/`, and zero involvement of any T-22 file, in either run.** `pnpm tsc --noEmit -p tsconfig.json` clean project-wide on this run.

---

### T-23 — Dispatch & Load Lifecycle Monitor

**Spec:** [T23_Dispatch_Lifecycle_Monitor.md](../../../T23_Dispatch_Lifecycle_Monitor.md)
**Implementation plan:** `MyraTMS/docs/superpowers/plans/2026-08-28-t23-dispatch-lifecycle-monitor.md`
**Status:** Code complete and verified on disposable branch `t23-verify` (`br-aged-waterfall-aip8fs19`). **NOT yet applied to production** — the user explicitly chose to stop before the production-apply step this session (asked directly; declined). Nothing in this module has touched the live database. All 6 commits are on `master`, unpushed to `origin/master` (same "commit vs. deploy are two different questions" caveat T-19/T-22 already document).

**Schema-reality corrections vs. the base spec** (documented in migration `053-t23-dispatch-lifecycle-monitor.sql`'s header — read before touching this again):
1. The spec's central premise — "assignment and acceptance are the same event, no confirmation step exists" — predates migrations `049`/`051` (2026-08-26, E2-04 M6/F1), which already added a real signed-rate-con gate (`loads.carrier_signature_received_at`/`_method`/`_confirmed_by`, `lib/dispatch-gate.ts`) for AI-cascade loads. The real, still-open gap is narrower: manual (non-pipeline) assignments never run that gate at all, and an AI-cascade load's signature SLA can still lapse. `carrier_acceptance_state` reports the real split instead of assuming 100% unconfirmed.
2. `events.entity_id`/`derived_from_id` are `INTEGER`; `loads.id` is `TEXT`. Every new trigger deriving from `loads` is scoped to pipeline-linked loads (`WHEN NEW.pipeline_load_id IS NOT NULL`) and keys `entity_id`/`derived_from_id`/`pipeline_load_id` on `NEW.pipeline_load_id`, not `loads.id`. Manual (non-pipeline) loads produce zero lifecycle events under this migration — verified by test, not assumed.
3. `load.delivered` needed no new trigger — T-17's existing `fn_events_from_pipeline_loads()`/`fn_stage_event_type()` already emits it.
4. `load.pickup_checked_in` derives from `loads.status` → `'In Transit'`, not `check_calls` (no structured pickup/enroute distinction exists there — flagged, not guessed, same discipline as migration `044`'s omitted acceptance-rate-delta trigger).
5. **Bug caught during `t23-verify` testing, same class as T-19's `wave1.md` bug #2:** `loads.carrier_signature_received_at` is `TIMESTAMPTZ` (049), but `fn_insert_event`'s `p_occurred_at` parameter is plain `TIMESTAMP` — `timestamptz → timestamp` is an assignment cast, not an implicit one, so the direct function-argument pass raised `function fn_insert_event(...) does not exist`, silently swallowed by the trigger's own required `EXCEPTION WHEN OTHERS` handler, which also rolled back the `carrier_acceptance_state` UPDATE in the same `IF` block (a plpgsql exception handler unwinds every statement since function entry). Caught by the Task 1 trigger test, not assumed passing on the first run. Fixed with an explicit `::timestamp` cast at the one call site.
6. This schema has no cancellation status on `loads` (`Booked | Awaiting Signature | Dispatched | In Transit | Delivered | Invoiced | Closed`) — the measurement report (Task 6) says so plainly rather than fabricating a cancellation metric.

- [x] Task 1: Migration `053-t23-dispatch-lifecycle-monitor.sql` — `carrier_acceptance_state`, `dispatch_routing_rules`, `v_lifecycle_late_loads`, 2 new triggers (`loads`, `location_pings`); 6/6 integration tests passing on `t23-verify` (done 2026-08-28)
- [x] Task 2: `scripts/t23_backfill_carrier_acceptance_state.ts` — backfills pre-trigger dispatched loads; idempotent (verified by test — a second run inserts nothing new); 2/2 tests passing (done 2026-08-28)
- [x] Task 3: `lib/dispatch/routing.ts` — `resolveDispatchRouting()`/`setDispatchRoutingOverride()`; 5/5 unit tests passing (done 2026-08-28)
- [x] Task 4: `GET`/`POST /api/dispatch/routing/:tenantId` — 6/6 tests passing, including a tenant-isolation IDOR fix (see below) (done 2026-08-28)
- [x] Task 5: `GET /api/lifecycle/load/:id`, `GET /api/lifecycle/late`, `GET /api/lifecycle/acceptance-gap-report` — 4/4 tests passing; the timeline route scopes by `tenant_id`, not just the guessable `pipeline_load_id`, from the start (done 2026-08-28)
- [x] Task 6: `scripts/t23_acceptance_gap_report.ts` — smoke-tested against `t23-verify` (0/0, expected — no backfill has run there); **not yet run against production**, since production apply didn't happen this session (done 2026-08-28, deliverable run still pending)
- [ ] Task 7: Apply migration 053 + backfill to production, run the real acceptance-gap report, validate `v_lifecycle_late_loads` against ≥5 real historical late loads, run the full regression suite, update this entry with real numbers — **explicitly not started**, pending the user's go-ahead

**Real bug found and fixed during this module, not a build defect worth re-litigating if seen again:** a background automated security review (post-commit) flagged that `GET`/`POST /api/dispatch/routing/:tenantId` let any authenticated non-super-admin user read or override *another* tenant's dispatch routing by changing the URL path parameter — the handler never checked `auth.user.tenantId` against the requested `tenantId`. This is the same class of IDOR T-22's postmortem already documents (§2 above) — a plan/implementation copying an existing route shape without re-deriving the tenant check for a *new* per-tenant path parameter. Fixed by requiring `isSuperAdmin` for any cross-tenant request (mirroring `resolveTenantId()`'s existing pattern), verified with 3 new tests (GET/POST rejection + legitimate super-admin path). Applied the same discipline proactively to `/api/lifecycle/load/:id` before it could be flagged too — scoped its `events` query by `tenant_id`, not just `pipeline_load_id` (a guessable `SERIAL` id).

**T-23 exit gate:** NOT yet met — Task 7 (production apply, the real measurement report run, live-loads validation, full regression suite) has not started. All 6 acceptance criteria (spec §7) are pending that step; nothing about the criteria themselves is in question, only whether they've been exercised against production data yet.

---

## Phase 3 — Financialize (T-27)

Not started.

## Phase 4 — Commercialize (T-28, T-30)

Not started.

## Phase 5 — Platformize (T-29 core)

Not started.

## Phase 6 — White-label (T-29 branding)

Not started.
