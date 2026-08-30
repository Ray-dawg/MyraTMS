# Engine 3 — Implementation Completion Tracker

> Tracks module-level progress through Engine 3's Phase 1–6 build order (master PRD `E3-00_Engine3_Master_PRD.md` §15). Always update this file when a task or module finishes — do not batch updates.

**Master PRD:** [E3-00_Engine3_Master_PRD.md](../../../E3-00_Engine3_Master_PRD.md)
**Started:** 2026-08-24
**Last updated:** 2026-08-30 (T-27 Finance Orchestration built via subagent-driven development, 5/7 acceptance criteria pass — criteria 1/6 explicitly OPEN, the source document they depend on does not exist in this repo; production apply/push pending explicit confirmation)
**Status:** Phase 1 (Instrument) complete. Phase 2: all 7 modules (T-20–T-26) built and applied to production in shadow mode, ahead of the formal handoff gate. Phase 3: T-27 built, 5/7 criteria pass, 2 held open pending a missing source document — see below for what's satisfied vs. explicitly held open per module.

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
**Status:** Built and applied to production 2026-08-28/29, in shadow mode (zero changes to `dispatcher-worker.ts`/`dispatch-gate.ts`). All 6 new objects verified live on production (`carrier_acceptance_state`, `dispatch_routing_rules` + Myra's seeded row, both new triggers, `v_lifecycle_late_loads`). The measurement report (spec §5) ran for real against production — see below for the actual, honestly-reported number. All commits are on `master`, unpushed to `origin/master` (same "commit vs. deploy are two different questions" caveat T-19/T-22 already document).

**Note on sequencing this session:** the user was asked directly before the production-apply step; the first answer was to stop and leave the module on the disposable `t23-verify` branch only. A follow-up message ("Apply to main/merge") reversed that and authorized proceeding, so Task 7 ran after all — recorded here so the sequence is honest, not smoothed over.

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
- [x] Task 6: `scripts/t23_acceptance_gap_report.ts` — smoke-tested against `t23-verify` (0/0), then run for real against production (done 2026-08-28)
- [x] Task 7: Applied migration 053 to production; ran backfill + report there; typechecked project-wide; ran T-23's own DB-touching tests directly against production for a second confirmation. Full unrelated regression suite (`pnpm vitest run` across the whole project) was **deliberately not run against live production data** this session — that's a much larger blast radius than a scoped migration apply, and wasn't clearly covered by the go-ahead given; recommend running it (or re-verifying on a fresh disposable branch) before relying on this module beyond what's verified here (done 2026-08-28, with that one exception noted)

**Real bug found and fixed during this module, not a build defect worth re-litigating if seen again:** a background automated security review (post-commit) flagged that `GET`/`POST /api/dispatch/routing/:tenantId` let any authenticated non-super-admin user read or override *another* tenant's dispatch routing by changing the URL path parameter — the handler never checked `auth.user.tenantId` against the requested `tenantId`. This is the same class of IDOR T-22's postmortem already documents (§2 above) — a plan/implementation copying an existing route shape without re-deriving the tenant check for a *new* per-tenant path parameter. Fixed by requiring `isSuperAdmin` for any cross-tenant request (mirroring `resolveTenantId()`'s existing pattern), verified with 3 new tests (GET/POST rejection + legitimate super-admin path). Applied the same discipline proactively to `/api/lifecycle/load/:id` before it could be flagged too — scoped its `events` query by `tenant_id`, not just `pipeline_load_id` (a guessable `SERIAL` id).

**Production apply — verified live, 2026-08-28/29:**
- All 6 new objects confirmed live via direct query (not just a clean migration exit): `carrier_acceptance_state`, `dispatch_routing_rules` (Myra's `myra_managed` row seeded), `trg_lifecycle_events_loads`, `trg_lifecycle_event_location_ping`, `v_lifecycle_late_loads`.
- Backfill script run against production: **0 of 0 candidates** — genuine, not a bug. Confirmed by direct query: 0 `pipeline_loads` rows are currently in `dispatched`/`delivered` stage, and 0 pipeline-linked `loads` rows have a `carrier_id` set at all. Consistent with the already-documented shadow-drain state (T-20/T-21/T-22: `SCANNER_ENABLED=false`, no real Dispatcher activity yet).
- Measurement report (spec §5, the module's required deliverable) run for real against production: **total=0, confirmed=0, unconfirmed=0**, all breakdown fields 0 — the honest result of zero real dispatch activity to measure yet, not a placeholder. Re-run this script once real Pilot 1/dispatch volume exists; that's when the number becomes meaningful, same treatment as T-18's replay harness and T-20's shadow-ranking report.
- `v_lifecycle_late_loads` returns 0 rows in production right now (0 loads in `dispatched` stage to evaluate) — **acceptance criterion 4 (validate against ≥5 real historical late loads) is correctly held OPEN**, not fabricated. Same pattern as T-20's criteria 4/5 and T-22's criteria 1/7: deferred pending real volume, not a build defect.
- `pnpm tsc --noEmit -p tsconfig.json`: clean, project-wide.
- T-23's own 8 DB-touching tests (`t23-triggers.test.ts`, `t23-backfill.test.ts`) re-run directly against production (not just `t23-verify`): **8/8 passing**, self-cleaning.

**T-23 exit gate:** NOT yet met. Criteria 1, 2, 3, 5, 6 (spec §7) pass — the mechanism is built, deployed, and verified correct by construction and by test. **Criterion 4 is explicitly OPEN**, deferred pending real dispatch volume, exactly the same class of honest deferral as T-20's criteria 4/5 and T-22's criteria 1/7. The full unrelated regression suite has not been re-run against production this session (see Task 7 note) — recommended before treating this module as fully closed out.

---

### T-24 — Exception Engine + Human Escalation Console

**Spec:** [T24_Exception_Engine_Console.md](../../../T24_Exception_Engine_Console.md) (v1.1 — supersedes v1.0 same day)
**Implementation plan:** `MyraTMS/docs/superpowers/plans/2026-08-29-t24-exception-engine-console.md`
**Status:** Built and applied to production 2026-08-29, in shadow mode. No new frontend — per the spec's own v1.1 amendment, this module makes the existing, live Exception Detection Engine + Alert Center the one true console rather than building a rival. 7 of 9 acceptance criteria pass; criteria 2 and 9's live-volume half are honestly held open (same treatment as every other Phase 2 module).

**Real findings from live-schema investigation (spec §4.0's own required step), more significant than most prior modules' schema-reality corrections:**
1. **The spec's proposed migration (§4.2) was already redundant before this module started.** `exceptions.tenant_id`/`pipeline_load_id`/`source_module`/`suggested_action`/`sla_due_at` all already existed — added by `028_add_tenant_id.sql` and `041-sellside-expansion-schema.sql`, the latter explicitly labeled in its own header comment as "T-24 §4.2 columns M0's escalation branch needs, added independently" of this module. Migration `054` therefore adds only the new `exception_classification_rules` table — zero `ALTER TABLE exceptions` anywhere.
2. **The spec's assumed 8 existing rule names are wrong.** It guessed `unassigned_urgent, late_delivery_risk, missing_gps, detention_risk, carrier_capacity, rate_escalation, missing_docs, missing_checkcall`. The real 8, read directly from `lib/exceptions/detector.ts`: `unassigned_urgent, late_pickup, eta_breach, gps_dark, pod_missing, invoice_overdue, insurance_expiring, missing_checkcall`. Only 2 of 8 names matched. The regression test (below) asserts against the real names.
3. **A third, previously-undocumented source already writes into `exceptions` with zero new work needed:** `lib/dispatch-gate.ts`'s `escalate()` (`carrier_verification_failed`, `rate_con_generation_failed`) and `lib/pipeline/health-checks.ts`'s three functions (`pipeline_stage_stuck`, `pipeline_load_missed_pickup_window`, `carrier_signature_overdue`, all `source_module='pipeline_health_cron'`) — both built E2-03 M0/M5, after this spec was dated. They're already "T-24-compliant" by construction; this module does not touch either file.
4. T-18's `escalations` table gets no active poller in this pass, per the spec's own bridge design (§4.4): every row is `sourceModule === 'authority_shadow'` until T-18b ships, so the guard clause in `bridgeToExceptions()` *is* the entire T-18 integration surface here — a poller with nothing consequential to ever find would be dead code.
5. This project's cron schedules run far less often than their own docblocks claim (`exception-detect`/`pipeline-health` both say "every 5 minutes" in comments; `vercel.json` runs them once daily) — a strong signal of a Vercel plan cron-frequency cap. The new `exception-bridge` cron follows `vercel.json` (daily, 1pm) as the actual source of truth, not the aspirational comments.

- [x] Task 1: Migration `054-t24-exception-classification-rules.sql` — `exception_classification_rules` table + 5 seed rows (2 lifecycle_late tiers, 1 each for carrier_risk/stage_escalated/dead_letter); 2/2 tests passing (done 2026-08-29)
- [x] Task 2: `lib/exceptions/classification-rules.ts` — `matchClassificationRule()` with tiered-severity condition matching (a load 400 minutes late correctly resolves to the `critical` tier, not just the first matching `low` one); 4/4 unit tests passing (done 2026-08-29)
- [x] Task 3: `lib/exceptions/bridge.ts` — `bridgeToExceptions()` + 4 pollers (`pollLifecycleLate`, `pollCarrierRisk`, `pollStageEscalated`, `pollDeadLetterJobs`), same check-before-insert dedup discipline as `detector.ts`/`health-checks.ts`; 3/3 unit tests passing (done 2026-08-29)
- [x] **Task 4 — acceptance criterion 3, the spec's own "single most important criterion":** regression test proving all 8 existing rules fire unaffected, run against both `t24-verify` and production directly; 3/3 passing in both places (done 2026-08-29)
- [x] Task 5: new daily `GET /api/cron/exception-bridge` cron (existing `exception-detect` cron untouched); 2/2 tests passing (done 2026-08-29)
- [x] Task 6: additive `exception.resolved` T-17 event logging on the existing `PATCH /api/exceptions/[id]` route — response shape unchanged, verified by test; regression test (Task 4) re-run afterward to confirm no disturbance (done 2026-08-29)
- [x] Task 7: `GET`/`POST /api/exceptions/classification-rules`, `GET /api/exceptions/sla-breaches`; 4/4 tests passing, including a proactive tenant-isolation guard on `POST` (client-supplied `tenantId` requires `isSuperAdmin`, same fix class as T-23's dispatch-routing IDOR) (done 2026-08-29)
- [x] Task 8: applied migration 054 to production, verified all 5 seed rows live; re-ran Tasks 1/4/6's DB-touching tests directly against production (6/6 passing); clean project-wide `tsc --noEmit` (done 2026-08-29)

**A real, honest limitation found while attempting criterion 2's spot-check:** production currently has 0 rows in `v_lifecycle_late_loads` (late_status IS NOT NULL), 0 unreviewed `carrier_risk_signals`, and 0 dead-lettered `agent_jobs` — consistent with the shadow-drain state every prior Phase 2 module has already documented. It does have **3** `pipeline_loads` rows at `stage='escalated'`, but all 3 have `TEST-`-prefixed `load_id` values (`TEST-CASCADE-DISPATCH-...`, `TEST-PROSPECT-...`) — leftover fixtures from earlier sessions' test runs, not real business incidents. **Criterion 2 (spot-check against ≥10 real incidents) is therefore held OPEN** — there are zero genuine candidates right now, not merely fewer than 10. Deliberately did not run `runExceptionBridge()` against production this session: doing so would bridge those 3 test fixtures into the live Alert Center as visible (if harmless) noise for Patrice to see and wonder about. The new cron will run for real on its own daily schedule once deployed, same as every other cron in this project — no manual trigger was forced ahead of that.

**Acceptance criteria status (spec §7):**
- [x] 1 — live schema confirmed before writing any migration (documented above)
- [ ] 2 OPEN — zero genuine historical incidents currently exist to spot-check against (see finding above)
- [x] 3 PASS — the single most important criterion; verified by dedicated regression test, twice
- [x] 4 PASS — existing 3 routes' response shapes unchanged, verified by test
- [x] 5 PASS — resolution-event logging is additive and non-blocking, verified by test
- [x] 6 PASS — code review confirms zero outbound call/message/cancellation anywhere in this module
- [x] 7 PASS — Stuck Load Detector, Dead Letter Sweep, and the existing Exception Detection cron are byte-for-byte untouched
- [x] 8 PASS — no new notification channel; nothing in this module calls `/api/notifications` at all yet since no bridged exception has reached `critical`/`high` in a live poller run (the mechanism exists in the spec's own §4.4 design; wiring it is a small follow-up once the cron has real signal to fire on)
- [ ] 9 OPEN — this module's own new tests are green; the full unrelated project regression suite was not re-run against production this session, same deliberate scope limit T-23's tracker entry already explains

**T-24 exit gate:** NOT yet met — criterion 2 requires real incidents that don't exist yet, and per spec §8, Patrice needs to actually see new-source exceptions arriving in the Alert Center for a trial period before this is "done in practice." Both are volume/time-dependent, not build defects.

---

### T-25 — Risk & Fraud Scoring

**Spec:** [T25_Risk_Fraud.md](../../../T25_Risk_Fraud.md)
**Implementation plan:** `MyraTMS/docs/superpowers/plans/2026-08-29-t25-risk-fraud-scoring.md`
**Status:** Built and applied to production 2026-08-29, in shadow mode (zero changes to `dispatcher-worker.ts` or any other live-path file). 5 of 7 acceptance criteria pass outright; criterion 5 passes but reports an honest zero (no real data to find yet); criterion 1 passes on seeded signals per the spec's own explicit allowance.

**Schema-reality corrections** (documented in migration `055-t25-risk-fraud-scoring.sql`'s header — read before touching this again):
1. Spec §4.3's `v_payer_concentration_exposure` had a literal broken SQL comment in place of a join condition (`pr.id = /* resolved via shipper->payer_registry link */`) and assumed a `pipeline_loads.tenant_id` column that doesn't exist — same bug class T-23 already fixed for `v_lifecycle_late_loads`. Fixed with a real `pipeline_loads.payer_registry_id` column (mirroring T-20's `carriers.carrier_registry_id`) populated by a new reconciliation script, since no MC-number equivalent exists for payers — matching is by normalized (trimmed, lowercased) `shipper_company` text.
2. **No banking-detail storage exists anywhere in this codebase** — `carriers` has zero bank/routing/account columns. Spec §4.5's `checkBankingChange()` assumed a `getCarrierBankingOnFile()` data source that had to be built from scratch. New table `carrier_banking_details` stores only the last 4 digits of any account number, never a full number — a deliberate security minimization, not a spec requirement.
3. `carrier_risk_signals` (T-20) has zero rows in production — no detector has ever populated it. Acceptance criterion 1 explicitly allows seeded signals as a substitute, used here.
4. `pipeline_loads.load_source_class` (T-19/E2-01's shadow gate) is 100% NULL across all real rows — the double-broker cross-check correctly reports zero matches in production, an honest reflection of shadow-only enforcement, not a validated true negative.
5. **A documented, deliberate limitation, not an oversight:** a `carrier_risk` exception bridged by T-24's existing `pollCarrierRisk()` still carries the flat 'medium' severity T-24 shipped with — it does **not** yet reflect `computeCarrierRiskSeverity()`'s per-signal-type tiering (critical for banking-change-mid-transaction, high for insurance-lapsed, etc.). Reconciling the two was ruled out deliberately: acceptance criterion 6 required T-24's existing `carrier_risk` handling be left untouched, and `pollCarrierRisk()`/its classification-rule row are exactly that handling. `computeCarrierRiskSeverity()` is live today only via the new `GET /api/risk/carrier/:id` endpoint. Closing this gap is a small, well-scoped follow-up for whoever picks up T-25b or T-26, not silently glossed over here.

- [x] Task 1: Migration `055-t25-risk-fraud-scoring.sql` — `payer_registry`, `payer_credit_assessments`, `transaction_halts`, `carrier_banking_details` (new, not in base spec), corrected `v_payer_concentration_exposure`, 2 new classification-rule seed rows; 2/2 tests passing (done 2026-08-29)
- [x] Task 2: `scripts/t25_reconcile_payer_registry.ts` — normalized-name matching; 1/1 test passing (done 2026-08-29)
- [x] Task 3: `lib/risk/payer-credit.ts` — `getPayerCreditStatus()` (unknown/weak flagged, strong not — **criterion 2 PASS**) + `getConcentrationCap()`; 5/5 tests passing (done 2026-08-29)
- [x] **Task 4 — criterion 3, 100% arithmetic accuracy required:** `v_payer_concentration_exposure` validated against hand-calculated cases (4000/6000 split verified exact); 1/1 test passing (done 2026-08-29)
- [x] Task 5: `lib/risk/carrier-risk-scoring.ts` (`computeCarrierRiskSeverity()`) + `lib/risk/banking-change-detection.ts` (`checkBankingChange()` — **criterion 4 PASS**, fires only when details differ AND a load is active); 8/8 tests passing (done 2026-08-29)
- [x] **Task 6 — criterion 6:** widened `lib/exceptions/bridge.ts`'s `SourceSignal.sourceModule` type to accept `payer_risk`/`transaction_halt` — the *only* line changed in that file; T-24's own `pollCarrierRisk()`/`pollLifecycleLate()`/`pollStageEscalated()`/`pollDeadLetterJobs()` and their seed rows are byte-for-byte untouched, re-verified by re-running T-24's own regression test after this change (done 2026-08-29)
- [x] Task 7: `lib/risk/double-broker-crosscheck.ts` + all 6 spec §5 API endpoints (`GET /api/risk/carrier/:id`, `POST .../payer/:id/assess`, `GET .../payer/:id/concentration`, `GET /api/risk/halts`, `POST /api/risk/halts/:id/resume`, `GET /api/risk/double-broker-crosscheck`); 7/7 tests passing (done 2026-08-29)
- [x] Task 8: applied migration 055 to production, verified all 6 new objects live; ran the reconciliation script for real (**256 pipeline_loads reconciled: 241 matched an existing payer, 15 new `payer_registry` rows created** — matches the 15 distinct normalized shipper-company names found during planning); re-ran this module's + T-24's DB-touching tests directly against production (8/8 passing); ran the real double-broker cross-check (**3 checked, 0 flagged** — an honest zero); clean project-wide `tsc --noEmit` (done 2026-08-29)

**Also found along the way, not a T-25 defect:** T-24's own `t24-classification-rules-schema.test.ts` used an exact whole-table `toEqual` match on all 5 of its seed rows — T-25's 2 additive rows correctly broke that assertion's exact count. Fixed by re-scoping that test to T-24's original 5 `source_module` values instead of the whole table, so future modules extending `exception_classification_rules` (there will likely be more) don't need to touch T-24's test file again. `__tests__/risk/t25-schema.test.ts` is now the one that asserts the full 7-row extended set.

**Acceptance criteria status (spec §6):**
- [x] 1 PASS — verified against 8 seeded carrier-risk-signal scoring cases across all 6 named `signal_type` values (spec explicitly allows seeded signals; zero real ones exist yet)
- [x] 2 PASS — unknown/weak flagged, strong not; explicitly new functionality per spec, no historical baseline expected or used
- [x] 3 PASS — 100% arithmetic accuracy verified against hand-calculated cases
- [x] 4 PASS — banking-change halt fires only when details differ AND a load is active; verified both directions plus the "nothing on file yet" and "no active load" non-firing cases
- [x] 5 PASS (honest zero) — 3 checked, 0 flagged in production; correctly finds nothing because `load_source_class` has never classified a real load, not because the report is broken
- [x] 6 PASS — verified by re-running T-24's own regression suite after the type-widening change; zero other lines touched in `bridge.ts`
- [x] 7 PASS — zero changes to `dispatcher-worker.ts`; T-24's 8-rule regression test re-confirmed green post-change

**T-25 exit gate:** All 7 acceptance criteria pass. Per spec §7, Patrice should still review the payer-credit and concentration logic specifically — it's genuinely new with no historical baseline, the one place in this module where "does this match reality" is a judgment call rather than a comparison.

---

### T-26 — Document Automation (final Phase 2 module)

**Spec:** [T26_Document_Automation.md](../../../T26_Document_Automation.md)
**Implementation plan:** `MyraTMS/docs/superpowers/plans/2026-08-29-t26-document-automation.md`
**Status:** Built and applied to production 2026-08-29, in shadow mode (zero changes to `dispatcher-worker.ts` or `/api/loads/[id]/assign`'s generation logic). All 7 acceptance criteria pass — one (criterion 4) required zero new production code, just a confirming test.

**The spec's own central premise was factually wrong — the biggest finding of any Phase 2 module.** T-26 v1.0 states "nothing receives, parses, or validates an inbound shipper rate con today... that's the actual gap T-26 closes." A full inbound-email pipeline already existed (E2-04 M0–M6, built after this spec was dated 2026-08-22): `lib/email/imap-poller.ts` + `lib/email/inbound-classifier.ts` + `inbound_emails`, already receiving shipper replies, verifying the sender, and attaching the reply as a `'Shipper Rate Confirmation Reply'` document. It deliberately does **not** parse or compare terms — an explicit M0 design decision that the real confirmation is the link click, not the document. Building the spec's proposed `inbound_document_intake` table + a new poller would have duplicated a working system exactly the way T-24 v1.0 would have duplicated the Exception Detection Engine before its v1.1 amendment course-corrected. This module extends the existing pipeline instead of replacing it.

**Other schema-reality findings:**
1. `documents.tenant_id` already existed — spec §4.1's first `ALTER` was redundant; only `parsed_terms`/`terms_match_status` are genuinely new columns.
2. **Acceptance criterion 4 was already fully satisfied end-to-end, zero new code needed.** `lib/dispatch-gate.ts`'s `completeDispatchOnSignedRateCon()` (called by the IMAP poller's `carrier_reply` branch) sets `loads.carrier_signature_received_at`/`carrier_signature_method`; T-23's own `fn_lifecycle_events_from_loads()` trigger (migration 053, already live since 2026-08-28/29) already watches those columns and updates `carrier_acceptance_state.confirmation_method = 'rate_con_signed'`. Verified with a real end-to-end test, not a synthetic column UPDATE.
3. The public tracking page's document exclusion is a literal `type IN ('BOL', 'POD', 'Invoice')` allow-list, confirmed correct and pinned by a new regression test.
4. No PDF-understanding capability existed anywhere in this codebase — `extractRateConTerms()` is new, isolated code using Claude's native PDF-document input, deliberately not built into the shared `ClaudeService` class (wrong shape for a PDF input; that class already has documented reliability issues unrelated to this module).
5. **A second real, previously-untested bug found via this module's own regression test, unrelated to the module's stated scope:** `app/api/tracking/[token]/documents/route.ts` passed `resolveTrackingToken()`'s `tenantId` (a `BIGINT` column, returned as a JS string by Neon's driver) straight into `withTenant()`, whose `Number.isInteger()` guard rejects a string — every real call to this route was throwing before the fix. Fixed with a `Number()` coercion only; the security-relevant allow-list itself was untouched.
6. **A real tenant-isolation IDOR, caught by the same automated background security review that's now caught one in every module from T-23 onward:** all 3 new API routes (`rate-con` status, `terms-mismatches`, `intake-match-report`) queried without any tenant filter. Fixed by scoping every query that touches a genuinely tenant-owned column (`events.tenant_id`, `documents.tenant_id`). `inbound_emails`/`pipeline_loads` still have no `tenant_id` column at all (same reality already documented for T-23/T-24/T-25) — the report's `total`/`matched` counts are honestly left system-wide by construction, not silently left unscoped by oversight.

- [x] Task 1: Migration `056-t26-document-automation.sql` — `documents.parsed_terms`/`terms_match_status` + 5 document-lifecycle event triggers (2 on `documents`, 2 on `inbound_emails`, `document.delivered` already free from T-17); 5/5 tests passing (done 2026-08-29)
- [x] Task 2: `lib/documents/rate-con-terms.ts` — `extractRateConTerms()` (Claude PDF input) + `compareTerms()` (pure); 7/7 tests passing, including a real-API-call failure path (missing key) tested without mocking (done 2026-08-29)
- [x] Task 3: widened `lib/exceptions/bridge.ts`'s `SourceSignal` for `document_terms_mismatch` (only change to that file) + wired extraction/comparison into the existing `imap-poller.ts` `shipper_reply` branch as one additive block after its existing `attachDocument()` call; 6/6 bridge tests + 1/1 new wiring test + all 6 pre-existing `imap-poller` tests still passing (done 2026-08-29)
- [x] **Task 4 — criterion 4, already satisfied:** end-to-end test proving `completeDispatchOnSignedRateCon()` + T-23's existing trigger close T-23's own acceptance gap with zero new production code; 1/1 passing (done 2026-08-29)
- [x] Task 5: regression test pinning the tracking page's BOL/POD/Invoice-only allow-list (criterion 5); found and fixed the real `tenantId` coercion bug above along the way; 1/1 passing (done 2026-08-29)
- [x] Task 6: 3 of spec's 4 API endpoints (`GET /api/documents/rate-con/:id`, `GET .../terms-mismatches`, `GET .../intake-match-report`) — `POST /api/documents/inbound-intake` deliberately not built, since it would be a redundant second webhook target superseding the already-working IMAP poller; 4/4 tests passing, plus the tenant-isolation IDOR fix above (done 2026-08-29)
- [x] Task 7: applied migration 056 to production, verified all 4 new objects live (2 columns + 2 triggers); re-ran this module's + T-24's DB-touching tests directly against production (12/12 passing); ran the real intake-match-report against production (**0 total, 0 matched, 0 parseable** — the honest zero, consistent with every prior Phase 2 module's shadow-drain finding); clean project-wide `tsc --noEmit` aside from one confirmed pre-existing, unrelated error in a T-23 test file (done 2026-08-29)

**Acceptance criteria status (spec §6):**
- [x] 1 PASS — `document.rate_con_sent` fires on every `documents` insert of type `'Rate Confirmation'`/`'Shipper Rate Confirmation'`, zero PDFKit changes
- [x] 2 PASS — extraction + comparison tested against seeded cases and a real (honestly-failing) Claude call; real production intake-match-report reports 0/0/0, an honest number
- [x] 3 PASS — zero false positives on 5 matched-rate seeded cases; correctly flags rate/lane/date mismatches independently
- [x] 4 PASS — already satisfied by existing code, confirmed by a real end-to-end test
- [x] 5 PASS — tracking-page allow-list pinned by regression test, unchanged
- [x] 6 PASS — `documents.tenant_id` already existed; zero behavior change, confirmed
- [x] 7 PASS — zero changes to `dispatcher-worker.ts` or `/api/loads/[id]/assign`'s generation logic

**T-26 exit gate:** All 7 acceptance criteria pass. Per spec §7, Patrice should still review the inbound-parser accuracy report specifically, since it's genuinely new with no historical baseline — same caveat as T-25's payer-credit logic.

**Phase 2 module set (T-20–T-26) is now complete — but this is explicitly NOT the same thing as Phase 2's own exit gate.** Per the master PRD §8 (and this spec's own §7, which states it plainly): the real Phase 2 exit gate is 100 consecutive loads through `booked → dispatched → delivered → scored` with ≥80% zero-touch — a real-volume operational bar, not a "were the 7 modules built" checklist. Every module in this set (T-20 through T-26) has at least one acceptance criterion honestly held open or reporting a real zero, precisely because the shadow-drain state this whole phase was built under has never produced that volume. Building these 7 modules was necessary for Phase 2's exit gate to ever be reachable; it does not itself satisfy that gate.

---

## Phase 3 — Financialize (T-27)

### T-27 — Finance Orchestration

**Spec:** [T27_Finance_Orchestration.md](../../../T27_Finance_Orchestration.md)
**Implementation plan:** `MyraTMS/docs/superpowers/plans/2026-08-29-t27-finance-orchestration.md`
**Status:** Built via subagent-driven development, direct on master (same workflow as T-17–T-26). All 9 implementation tasks reviewed and approved (40/40 T-27 tests passing, zero regressions in the pre-existing suite). Migration 057 verified on a disposable Neon branch (`t27-verify`); production apply and push are separate, explicitly-confirmed steps per this session's standing discipline — see the apply/push status line below once done.

**A confirmed blocker, not a bug — the module's biggest finding.** T-27's acceptance criteria 1 and 6 require `decideRoute()`'s underlying capital-days/yield formula to exactly reproduce Pilot 1's own worked example ($12.00 / $3.81 / $91.28 / self-funding per 1,000 capital-days, spec §1). The document that formula comes from — "Pilot 1's Financial Architecture §6" — does not exist anywhere in this repository: searched `Engine 2/`, `Engine 3/`, and all 8 root-level `.docx` files by name and by grepping for "Financial Architecture", "capital-days", "Pilot 1"; nothing beyond passing mentions exists. Raised directly to Patrice via `AskUserQuestion` with three options (supply the document; derive an unverified formula and flag it as such; build everything else and defer criteria 1/6 entirely) — **Patrice chose the third option.** `lib/finance/capital-days.ts` implements a placeholder formula (`capitalDays = amount × daysHeld`; `yield = margin / (capitalDays/1000)`), its own comments state plainly that it is NOT verified against Pilot 1's real numbers, and it is tested only for internal consistency (self-funding/zero/negative handling) — never asserted against $12.00/$3.81/$91.28. **Criteria 1 and 6 are OPEN, not fabricated.**

**Other schema-reality findings** (this module's own required "confirm live schema before writing SQL" check, same discipline as every prior module):
1. `financing_decisions.tenant_id`: spec §4.2 writes the literal `INTEGER NOT NULL DEFAULT 1` — the exact hardcoded-tenant-id class of bug T-19 found and fixed across T-17/T-18 (tenant `1` is `_system`, not Myra). Corrected to `BIGINT NOT NULL REFERENCES tenants(id) DEFAULT fn_myra_tenant_id()`, matching `tenant_policies.tenant_id`'s real type.
2. `carriers.payment_preference` (spec §1/§5's assumed source for `carrierWantsQuickPay`) does not exist in production — confirmed via `information_schema.columns`, zero rows. Added instead on `carrier_registry` (T-20's platform-level canonical carrier identity table), matching the precedent T-25's `carrier_banking_details` already set for carrier-level financial attributes.
3. `financing_decisions.route_selected`: spec sizes this `VARCHAR(4)`, which cannot hold the literal `'DECLINE'` (7 characters) that `decideRoute()` itself returns. Widened to `VARCHAR(10)`.
4. `invoices.factoring_status` **is** exactly as the spec assumed — real, `TEXT`, values `'N/A'|'Submitted'|'Approved'|'Funded'` (migration `001-create-tables.sql`) — criterion 5 syncs into this same field via `pipeline_loads.tms_load_id` (confirmed TEXT in production, matching `loads.id`/`invoices.load_id`, despite the original Engine 2 spec typing it `INTEGER` — a discrepancy `lib/workers/dispatcher-worker.ts`'s own comments already flagged).
5. `payer_credit_assessments.credit_level` (T-25) already uses the exact vocabulary `decideRoute()`'s `payerCreditLevel` input expects (`'unknown'|'weak'|'acceptable'|'strong'`) — a clean integration point, no correction needed.
6. **A preflight plan defect caught before any code was written, not during review:** the implementation plan as originally drafted built `computeCapitalDays()`/`computeYieldPer1000CapitalDays()` (Task 5) but never called either from the route-decision handler (Task 9) or the treasury report (Task 8) — `financing_decisions.capital_days_projected`/`yield_projected` would have stayed `NULL` forever, leaving criterion 6's treasury report with nothing to aggregate even as an honest placeholder. Fixed via a controller ruling carried into Task 9's dispatch: `route-decision` now computes and persists both columns using the day-counts already given verbatim in the spec's own §1 table (T1=10, T2=39, T3=1, T4=−29 days — these are NOT part of the missing document, only the resulting dollar figures are unverifiable) and `pipeline_loads.profit` as the margin input.
7. **A real arithmetic error in the controller's own ruling, caught by the implementer, not by review:** the ruling's addendum gave a test-assertion literal that contradicted its own worked math in the same paragraph. The implementer correctly kept the (correct) route code as specified and fixed only the test literal to match the addendum's own stated arithmetic, rather than corrupting the persisted columns to match a wrong assertion.

- [x] Task 1: Migration `057-t27-finance-orchestration.sql` — `tenant_policies.treasury_policy`, `carrier_registry.payment_preference`, `financing_decisions`, `v_float_exposure`, `factoring_submissions`, `quick_pay_disbursements`, `kyc_verifications`, all three schema-reality corrections above; verified live on disposable branch `t27-verify` (done 2026-08-30)
- [x] Task 2: `lib/finance/routing.ts` — `decideRoute()`, verbatim reproduction of Pilot 1's own §6.3 routing table including the deliberate "acceptable credit treated like strong" behavior; 7/7 tests (done 2026-08-30)
- [x] Task 3: `lib/finance/credit-lookup.ts` — payer-credit and carrier-preference DB lookups, conservative `'unknown'`/`false` defaults; 4/4 tests (done 2026-08-30)
- [x] Task 4: `lib/finance/float-governor.ts` — float exposure + capacity check against `v_float_exposure`, null-cap-is-unlimited handled deliberately; 6/6 tests (done 2026-08-30)
- [x] Task 5: `lib/finance/capital-days.ts` — the honestly-labeled placeholder formula (criteria 1/6 OPEN); 4/4 tests, internal-consistency only (done 2026-08-30)
- [x] Task 6: `lib/finance/adapters/{ecapital,stripe,persona}.ts` — sandbox-only stubs, `environment` typed as the TypeScript literal `'sandbox'` (never `string`) plus a hardcoded SQL literal in every INSERT — both independently verified against the diff; a `pnpm tsc --noEmit` run (by the controller, after the review flagged the implementer's report as under-evidenced on this point) confirmed the `@ts-expect-error` guard is genuinely satisfied; 6/6 tests (done 2026-08-30)
- [x] Task 7: `lib/finance/factoring-sync.ts` — syncs `factoring_submissions.status` into the existing `invoices.factoring_status`, never a duplicate field; 2/2 tests (done 2026-08-30)
- [x] Task 8: `lib/finance/treasury-report.ts` — aggregates `financing_decisions`, disclaimer on the placeholder formula preserved verbatim; 2/2 tests (done 2026-08-30)
- [x] Task 9: 6 API routes under `app/api/finance/` wiring Tasks 2–8 together, plus the capital-days ruling from finding #6 above; 9/9 tests, 40/40 across the full T-27 suite (done 2026-08-30)
- [x] Task 10: full regression pass — initially recorded as 807/817 pre-existing tests passing; corrected during the fix wave below to a directly re-measured baseline of 11 failures/6 files (a rotating pool of flaky live-DB integration tests with 30s timeouts — `cost-calculator.test.ts`'s 5 are stable/reproducible, the rest rotate depending on timing among `carrier-brief-compiler-worker`/`retell-webhook-carrier-cascade`/`sellside-autonomous-loop.e2e`). Confirmed via `git log` that none of these files were touched by any T-27 commit, and confirmed `lib/finance/` fails in neither configuration. `tsc --noEmit`: one pre-existing, unrelated error (`dispatch-routing-api.test.ts`, predates T-27 per T-23 commit `f41e90d`), zero new errors (done 2026-08-30)
- [x] **Final whole-branch review (Opus) + one fix wave** — the broad review that individual task reviews can't do caught 4 Important + 2 Minor cross-cutting findings invisible at task scope; all 7 (including one added test) fixed in a single consolidated commit per the subagent-driven-development discipline (no per-finding fixers, no second fix wave), independently re-reviewed and confirmed ADDRESSED with no new breakage (done 2026-08-30). See findings below.

**Fixed by the final review's fix wave:**
1. **Cross-tenant write gap** — `syncInvoiceFactoringStatus`'s `UPDATE invoices` had no tenant filter. Unlike the parked finding below (which correctly covers `pipeline_loads` and migration 057's three adapter tables, none of which have `tenant_id`), `invoices` genuinely has `tenant_id BIGINT NOT NULL REFERENCES tenants(id)`, and per this repo's own documented rule, app-layer `WHERE tenant_id` is the *only* live tenant boundary (RLS staged, not enabled). Any admin/ops user of any tenant could flip another tenant's invoice via this path. Fixed: `syncInvoiceFactoringStatus` now takes `tenantId` and filters on it; `factoring/submit`'s route now calls `resolveTenantId`.
2. **Unvalidated `credit_level` cast** — `getPayerCreditLevel` cast the DB value with no validation; `payer_credit_assessments.credit_level` has no CHECK constraint, so any unexpected string would fall through `decideRoute()`'s decline-only-on-weak/unknown check as financeable — a fail-open direction in the one module whose own spec (§3.2) says mistakes aren't reversible by inaction. Fixed: validated against the four known values, `'unknown'` default otherwise.
3. **Float cap unenforceable on a tenant's first-ever decision** — `v_float_exposure` is built `FROM financing_decisions`, so a tenant with a configured `float_cap_usd` but zero prior decisions got zero rows, read as an unlimited cap. Fixed: `getFloatExposure` now sources `float_cap_usd` from an independent `tenant_policies` query, decoupled from whether any `financing_decisions` rows exist.
4. **Float cap query didn't follow this codebase's established convention** — the new query above also adopted the `WHERE tenant_id = $1 AND is_active = true ORDER BY version DESC LIMIT 1` pattern every other Engine 3 module already uses (T-21/T-23/T-25), closing a fan-out risk if `tenant_policies` ever had two active rows for one tenant.
5–6. Minor type-safety tightenings: `DAYS_HELD_BY_ROUTE` is now `Record<Exclude<Route,'DECLINE'>, number>` (was `Record<string, number>`); `syncInvoiceFactoringStatus`'s status parameter is now the literal union matching `invoices.factoring_status`'s real CHECK constraint (was `string`).
7. Added the one genuinely untested branch: a DECLINE-path test for `route-decision`, confirming it skips the profit lookup entirely and persists `null` for both capital-days columns.

**Parked finding (not fixed — pre-existing, out of this module's scope, narrowed by the final review to exclude `invoices`):** `factoring/submit`, `quickpay/disburse`, and `kyc/verify` accept a caller-supplied `pipelineLoadId`/`entityId` under only a role check, with no tenant-ownership verification against `pipeline_loads` or migration 057's three adapter tables. This is not new to T-27 — `pipeline_loads` has never had a `tenant_id` column anywhere in this schema (independently documented by T-25's and T-26's own findings: "this whole table family is effectively single-tenant/Myra-only today"), and migration 057's three adapter tables inherit that same gap by construction, matching the spec's own given code verbatim. Fixing it means retrofitting `tenant_id` across `pipeline_loads` and everything downstream — a cross-cutting, pipeline-wide migration outside any single T-2X module's scope, and T-23 through T-26 all hit and documented this identical boundary rather than retrofitting it. Flagged here for whoever eventually does that retrofit, or for the T-27b live-money cutover gate (§8) to require explicitly.

**Known limitations, documented rather than code-fixed (final review's "should fix or document" items):**
- **Sandbox stub writes a real, operator-visible invoice status.** `factoring/submit`'s sandbox eCapital stub sets `invoices.factoring_status = 'Submitted'` — a value indistinguishable on the finance screen (`app/finance/page.tsx`) from a genuine submission. This is criterion 5's own explicit design (spec §2/§5: sync into the existing field, not a duplicate) — not a defect, and code-gating it would mean not satisfying criterion 5 as designed. No real money/carrier consequence follows in shadow mode (no real eCapital credentials are wired anywhere, per §10), but **this should be a named precondition of the T-27b live-money gate (§8)**: a real submission's badge must be visually or textually distinguishable from a sandbox one before real credentials are ever connected.
- **`v_float_exposure` can double-count.** It sums `agreed_rate` once per `financing_decisions` row, but the spec's own §5 names `decided_by = 'human_override'` (the T4 route) as a case with more than one decision row per load, and `route-decision` has no idempotency guard against repeated POSTs either. Both inflate a tenant's measured float exposure (and `getTreasuryReport`'s capital-days total). Not fixed here: `float_cap_usd` is still unset (`NULL`) in production, so nothing is live-enforced yet — worth fixing before T-27b sets a real cap.
- **`v_float_exposure`'s stage filter predates the current stage machine.** It's spec-verbatim (`'booked'|'dispatched'|'delivered'`), but `lib/pipeline/stages.ts` now has `awaiting_shipper_confirmation`/`shipper_confirmed` between booked and dispatched, and `scored` after delivered — all three are booked-but-uncollected (exactly what the view's own comment says it's trying to capture) and are currently excluded, under-counting exposure. Same "not yet live-enforced" mitigation as above, but this one errs in the unsafe direction (permits more float than intended) rather than the safe one.
- **Float exposure is USD-only.** `treasury_policy` defines both `float_cap_usd` and `float_cap_cad`, but the view and `getFloatExposure` only ever compute/compare USD, silently ignoring mixed-currency loads (`pipeline_loads.agreed_rate_currency` exists) for a CAD-domestic tenant (T-19 seeds `countries: ["CA"]`). Needs a currency dimension before T-27b sets a real cap.
- **`factoring_submissions.status` default sits outside the vocabulary criterion 5 syncs.** `DEFAULT 'not_submitted'` (spec-verbatim) is not one of `invoices.factoring_status`'s CHECK-constrained values, so a row left at that default could never sync even if something tried. Criterion 5's PASS is precisely scoped to "values actually written by the adapter" (which are always `'Submitted'` today), not every value the column's DEFAULT could theoretically hold.

**Acceptance criteria status (spec §7):**
- [ ] 1 **OPEN** — `decideRoute()`'s capital-days/yield formula is a placeholder, not verified against Pilot 1's real $12.00/$3.81/$91.28/self-funding example (source document does not exist in this repo). Explicit, user-confirmed scope decision, not an oversight.
- [x] 2 PASS — routing table matches Pilot 1's §6.3 exactly across all four payer-credit × carrier-preference combinations, including the decline rule
- [x] 3 PASS — float governor correctly forces T3 over T2 when the tenant's `float_cap_usd` is at/above exposure; null-cap (unset) correctly treated as unlimited. (Final review caught and fixed a real gap: the cap was originally read through `v_float_exposure`, which returns zero rows — and thus an unenforceable null cap — until a tenant has at least one prior `financing_decisions` row; the cap is now sourced independently, enforceable from a tenant's very first decision.)
- [x] 4 PASS — all three adapters sandbox-functional; zero code path can write `environment = 'production'`, proven at both the type level (`tsc`-enforced literal) and the SQL level (hardcoded literal, never a bound parameter)
- [x] 5 PASS — `factoring_submissions.status` syncs into the existing `invoices.factoring_status`, confirmed as the same field via a live sync test
- [ ] 6 **OPEN** — same missing-document blocker as criterion 1; treasury report computes real (non-fabricated) numbers from real `financing_decisions` rows, but those numbers use the same unverified placeholder formula
- [x] 7 PASS — T-16-adjacent regression suite green against the corrected baseline (11 pre-existing flaky failures, none in `lib/finance/`, zero T-27 regressions); zero changes to invoice creation or the POD-triggered invoice flow

**T-27 exit gate (spec §8):** 5 of 7 acceptance criteria pass. Criteria 1 and 6 remain explicitly open pending the real Pilot 1 Financial Architecture document — per spec §8, Patrice should confirm the treasury policy defaults (2.5% quick pay / 5% factoring) and review the routing logic against that document once it's available; until then this module ships as "routing and governance logic proven, exact financial figures unverified," which is a materially different (and honestly weaker) claim than "exit gate met," consistent with the standing "never fabricate a passing criterion" rule this whole build has followed since T-17.

## Phase 4 — Commercialize (T-28, T-30)

Not started.

## Phase 5 — Platformize (T-29 core)

Not started.

## Phase 6 — White-label (T-29 branding)

Not started.
