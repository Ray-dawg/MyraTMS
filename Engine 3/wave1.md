# Wave 1 — T-18 (Agent Runtime & Governance) + T-19 (Tenant & Policy Model)

**Status as of 2026-08-25: both modules shipped to production — database migrations applied to the real Neon production branch, and application code pushed to GitHub / deployed via Vercel (build `73c750e`, confirmed successful). `evaluatePolicy()` now has its first real caller — see §7.**

This doc is a single reference for a future session picking up Engine 3 work: what these two modules actually built, the real bugs found while verifying them, the schema realities that forced a redesign away from the original specs, and what's still open. Read this before touching anything under `lib/governance/`, `lib/tenants/`, or migrations `034`/`035`. The design docs (linked below) have the full rationale; this doc is the "what actually happened and what to watch out for" summary.

Related tracker: `Engine 3/docs/superpowers/plans/completion.md` — the authoritative, continuously-updated module checklist. This doc is a narrative companion to it, not a replacement.

---

## 1. T-18 — Agent Runtime & Governance

**Spec:** `T18_Agent_Runtime_Governance.md` · **Design doc:** `MyraTMS/docs/superpowers/specs/2026-08-24-t18-agent-runtime-governance-design.md`

### What it is

T-18 gives every Engine 3 agent an **authority envelope**: a per-tenant, per-agent record of what it's allowed to do, what tools/budget it has, its confidence threshold, and its escalation rules. Every agent decision runs through `evaluateAuthority()`, which loads the active envelope, evaluates the action against it, and logs the outcome — allow, escalate, or deny — into an append-only `authority_evaluations` table. Escalations (L3 decisions) get a row in `escalations` for the Human Escalation Console.

Everything ships in **shadow mode** — T-18 observes and logs, it doesn't gate the live call path. That's deliberate: master PRD principle 1 forbids touching the live call path until Pilot 1 is green.

### What was built

- **Migration `034-agent-runtime-governance.sql`**: 4 tables — `agents`, `authority_envelopes`, `authority_evaluations`, `escalations`.
- **`lib/governance/evaluate.ts`** — `applyEnvelope()`, a **pure function** (no I/O) that takes an envelope + action + context and returns a decision. This is the core logic, and it's the reason 24 unit test scenarios could run in milliseconds with no database.
- **`lib/governance/evaluate-authority.ts`** — `evaluateAuthority()`, the thin DB wrapper: loads the envelope, calls `applyEnvelope()`, writes the audit row. Idempotent on `source_event_id` (an evaluation triggered twice by the same upstream event doesn't duplicate).
- **`scripts/t18_seed_governance.ts`** — seeds 10 agents + 8 default envelopes, reading real values from `.env.local`/`.env` rather than hardcoding kill-switch numbers (a mistake this script itself made once and was later fixed — see §4).
- **`scripts/t18_replay_shadow_evaluation.ts`**, **`t18_disagreement_report.ts`** — operator tooling to compare what the envelope *would have* decided against what actually happened, once real Retell call data exists. Both correctly report "no data yet" rather than fabricating a rate — there's been no live Pilot 1 traffic on this branch.
- **5 API routes**: `GET /api/agents`, `GET/POST /api/agents/:agentKey/envelope`, `GET /api/evaluations`, `GET /api/escalations`, `PATCH /api/escalations/:id` — all JWT-cookie auth, all tenant-scoped.

### The pure-core / DB-wrapper split — the pattern that shaped everything after it

This is the single most important architectural decision in T-18, and T-19 deliberately copied it:

```
applyEnvelope(envelope, action, context) -> decision      // pure, unit-tested, no DB
evaluateAuthority({ agentKey, tenantId, action, context }) // DB wrapper: load envelope, call above, write audit row
```

T-19's `evaluatePolicy()` is the same shape: `applyPolicy(policy, load, coBrokerAgreements)` (pure, 17 test scenarios) + `evaluatePolicy()` (DB wrapper, loads `tenant_policies` + `co_broker_agreements`, calls the pure function, writes into `authority_evaluations` under a `policy_engine` agent). **If a future module needs a rules engine, use this split.** It's fast to test, easy to reason about, and keeps the "what does the DB look like" concern completely separate from "what's the actual decision logic."

### Bugs found and fixed during T-18 verification

1. `authority_envelopes.agent_id` / `authority_evaluations.agent_id` had no `ON DELETE` behavior — broke test cleanup once rows existed. `agents` is never deleted by live code (only deactivated via `status`), so `ON DELETE CASCADE` was safe. **This becomes a recurring pattern**: any FK from a governance/event table back to a table that's "only ever deleted by test/ops code" should cascade.
2. The escalations PATCH route reused the `$1` placeholder across a plain assignment and a `CASE WHEN $1 IN (...)` in the same SQL statement — Neon's driver can't type-infer that. Fixed by computing the derived value in JS instead of SQL.
3. Found only by running the **full regression suite**, not T-18's own tests in isolation: `authority_evaluations.source_event_id` (FK to `events`) also needed a cascade — a T-18 idempotency fixture referenced an `events` row that a *different* test file's cleanup later tried to delete. **Lesson: run the full suite, not just the new module's tests, before calling anything verified.**

---

## 2. T-19 — Tenant & Policy Model

**Spec:** `T19_Tenant_Policy_Model.md` · **Design doc:** `MyraTMS/docs/superpowers/specs/2026-08-24-t19-tenant-policy-model-design.md`

### The redesign — why T-19 doesn't look like the base spec

The base T-19 spec was written without full access to the real schema, and assumed it would be *creating* `tenants`/`tenant_users` tables. Those tables already existed — migration `027_multi_tenant_foundation.sql` shipped them months earlier, with a materially different shape (`tenants.type` means "platform/billing relationship" — `operating_company` / `saas_customer` / `internal` — not "what kind of freight business"). Building T-19 required reconciling the spec's assumptions against reality first. Decisions made:

1. **Reuse `tenants`/`tenant_users` as-is.** No new tenant tables.
2. **`freight_business_type` is a new column, not a `tenant_config` entry.** It's a structural classification (broker/dispatcher/carrier/acquired_opco), not a scalar setting — `tenant_config` is a closed keyspace of settings/credentials, never used for structural fields, so overloading it would have been inconsistent with every other use of that table.
3. **Genuinely new tables**: `tenant_type_policy_templates` (4 default rows, one per `freight_business_type`), `tenant_policies` (versioned, per-tenant, overridable — Myra's v1 row matches the Broker template), `co_broker_agreements` (empty at launch). All use `BIGINT` tenant FKs matching the real `tenants.id`, not the base spec's assumed `INTEGER`.
4. **Migration 030 (mentioned in the base spec) was left untouched.** It's a separate, pending piece of schema work with its own gate; T-19 doesn't force it.

### The tenant_id mislabeling bug — the throughline of this entire wave

This is the most important thing in this document. **Production has two low-numbered tenants**: `id=1` is `_system`, `id=2` is `myra`. T-17 and T-18 (built before this was noticed) hardcoded `tenant_id = 1` everywhere — every trigger, every seed script, every test fixture — assuming `1` meant Myra. It didn't. Every T-17/T-18 event, envelope, evaluation, and escalation row in production was silently mislabeled to the `_system` tenant instead of Myra.

**T-19's migration 035 is, first and foremost, the fix for this.** It:

- Adds `fn_myra_tenant_id() RETURNS BIGINT` — resolves Myra's real id by `slug = 'myra'`. This is now **the only correct way** to refer to "the Myra tenant" anywhere in this codebase, in SQL or in application code. Never hardcode a tenant id again — not even `2`, since that's just as fragile as `1` was. Use the resolver or, in TS, look it up the same way `lib/tenants/margin-floor.ts` does.
- Rewrites every T-17 trigger function, `fn_insert_event`, and `v_cost_per_call` to call the resolver instead of the literal `1`.
- **Backfills** every existing `events`/`authority_envelopes`/`authority_evaluations`/`escalations` row from `tenant_id=1` to Myra's real id, and logs the correction into `tenant_audit_log`.

If you ever see `tenant_id = 1` in a query, a test fixture, or a hardcoded constant anywhere in this codebase going forward, **that is a bug** — it's re-introducing exactly the class of mistake this migration fixed. (Three pre-existing T-17/T-18 test files still had this hardcoded when T-19 verification ran — see §4.)

### The margin-floor consolidation

`compiler-worker.ts`, `qualifier-worker.ts`, and `researcher-worker.ts` each independently hardcoded the same ternary: `currency === 'CAD' ? 270 : 200`. This is what actually drives `auto_book_eligible` in production. Three *other* values existed and were all dead: a `.env.local` var (`999999`), a stale `tenant_config` seed (`200`... actually seeded differently), and T-18's envelope copy (a frozen `999999`). None of those three were wired into any real decision.

T-19 consolidated all of it into one path: `tenant_config.margin_floor_cad`/`margin_floor_usd` (corrected to the real live values, 270/200) read through `lib/tenants/margin-floor.ts`'s `getMarginFloor(currency)`. All three workers now call this instead of their own hardcoded ternary. The dead env var and the dead standalone `tenant_config` seed were removed. **This was a pure refactor — before/after parity was verified via test, not just asserted.**

### `evaluatePolicy()` — the same shape as T-18, applied to load-source policy

`lib/governance/evaluate-policy.ts` (`applyPolicy()`, pure) + `lib/governance/evaluate-policy-db.ts` (`evaluatePolicy()`, DB wrapper) decide whether a load is allowed to be worked, based on `tenant_policies.load_source_policy`:

| Policy value | Behavior |
|---|---|
| `any` | Accept any source (Carrier template) |
| `broker_or_shipper_direct` | Accept broker-posted or shipper-direct (Dispatcher template) |
| `shipper_direct_or_coBroker` | Accept shipper-direct; broker-posted only with an *active* `co_broker_agreements` row matching the poster's MC number (Broker template — Myra's actual policy) |
| `inherit` | Fails closed — an Acquired Opco tenant never resolved to a concrete type is a config error, not a silent allow |
| anything else | Fails closed |

Geographic scope (`domestic_only` + `countries`) is checked *before* load-source policy — a cross-border load is rejected under a domestic-only policy regardless of source. 17 pure-function test scenarios cover this; 4 integration tests cover the DB wrapper (load active policy, evaluate, log the decision under a `policy_engine` agent envelope — reusing T-18's `authority_evaluations` table, since a policy decision and an authority decision are the same kind of record).

**`evaluatePolicy()` was not called from anywhere in the live pipeline as of this section's original writing.** It existed, was tested, was deployed — but no caller invoked it, pending the shipper-direct/double-brokering signal (`isDirect`, `postingCompanyMcNumber`) that a **separate, concurrent session** was building at the same time (`e2-01-m1-session1`, migration `040_shipper_direct_gate.sql`). **That dependency landed the same day and the wiring is done — see §7.**

---

## 3. Bugs found during T-19 verification (the expensive ones)

These were caught only because the full regression suite was run against a disposable Neon branch before touching production — not because they were obvious.

1. **`v_cost_per_call`'s `CREATE OR REPLACE VIEW` failed outright.** `fn_myra_tenant_id()` returns `BIGINT`; the view's `tenant_id` output column was `INTEGER` (from the old `COALESCE(e.tenant_id, 1)`). Postgres refuses to change a view's column type via `CREATE OR REPLACE` — you'd need to `DROP VIEW` first. Fixed with a scoped `::integer` cast at both call sites inside the view definition, not a schema change.

2. **The serious one: every T-17 trigger silently stopped writing events the instant migration 035 first ran, with zero error surfaced anywhere.** All 5 trigger functions (`fn_events_from_pipeline_loads`, `_agent_calls`, `_agent_jobs`, `_consent_log`, `_scraper_runs`) call `fn_insert_event(fn_myra_tenant_id(), ...)` — but `fn_insert_event`'s `p_tenant_id` parameter is declared `INTEGER`. **`bigint → integer` is an *assignment* cast in Postgres, not an *implicit* one** — it's allowed when a value is being written into a column (`INSERT`/`UPDATE`/`DEFAULT`), but *not* when it's being passed as a function-call argument, which only accepts implicit casts. Every trigger's own `PERFORM fn_insert_event(fn_myra_tenant_id(), ...)` call therefore raised `function fn_insert_event(bigint, ...) does not exist` — and every trigger wraps its body in `EXCEPTION WHEN OTHERS THEN RETURN NEW`, so the error was swallowed silently and the parent table write succeeded normally. Event derivation just stopped, invisibly. Caught only because `events-triggers.test.ts` / `events-views.test.ts` expect specific new rows to appear and found none.

   **The general lesson**: if a SQL function's return type doesn't exactly match a callee's declared parameter type, and the mismatch is in the "not implicitly castable but assignment-castable" zone (bigint→integer is the common one you'll hit again), a `PERFORM`/`SELECT` call to that function will fail — but an `INSERT ... VALUES (...)` or `UPDATE ... SET col = ...` using the exact same expression will succeed silently. Test *both* the write path and the function-call path when changing a resolver function's return type.

   Fixed with `::integer` casts at all 10 call sites in migration 035 plus 11 in `scripts/t17_backfill_events.ts` (which has the identical pattern, since it's essentially the same trigger logic run as a one-time backfill query). One call site — the `fn_stage_event_type(NEW.stage)` branch inside `fn_events_from_pipeline_loads` — was missed on the first pass because it doesn't match a simple `fn_myra_tenant_id(), '<literal>'` search pattern; caught by a targeted `grep` afterward. **If you ever touch these trigger functions again, grep for every bare `fn_myra_tenant_id()` call-site argument, not just the ones that look like the common case.**

3. **`getMarginFloor()`'s ternary silently guessed instead of validating.** `currency === 'CAD' ? key1 : key2` maps *any* non-`'CAD'` value (including a bad one that slipped past TypeScript's type system) to the USD key — an invalid currency would silently return $200 instead of erroring. Fixed by deriving the key generically (`` `margin_floor_${currency.toLowerCase()}` ``) so an unmapped currency naturally misses in `tenant_config` and throws the existing "no such key" error.

4. **Three pre-existing T-17/T-18 test files hardcoded `tenant_id = 1`** — the exact stale assumption T-19 corrects. Once real rows correctly moved to tenant id 2, these assertions started finding nothing (`events-views.test.ts`'s three view queries; `__tests__/governance/api.test.ts`'s mock session and seed fixtures — this is what made the previously-passing "returns the seeded voice envelope" test start returning 404, since the real `voice` envelope correctly lives at tenant 2 now). Fixed by resolving the tenant dynamically instead of hardcoding.

5. **Two integration tests raced against the full suite's own concurrent activity.** `evaluate-authority.test.ts` (T-18) and this session's new `evaluate-policy-db.test.ts` (T-19) both picked their idempotency-test event fixture via `SELECT id FROM events ORDER BY id DESC LIMIT 1` — a shared, mutable "latest row" that another test file can delete between a test's two calls under a full-suite run, producing a genuine (if rare) FK violation. Fixed both to `INSERT` and clean up a dedicated event row instead of borrowing someone else's.

**Confirmed pre-existing and unrelated to T-19** (do not spend time chasing these when re-running the suite): `ranker.test.ts` times out doing real per-carrier DB round-trips against 207 production-forked carriers on any branch cloned from production — documented back in T-17's own verification. `lib/pipeline/__tests__/cost-calculator.test.ts` has 5 failing pure-arithmetic assertions with zero DB or tenant involvement; the file is untouched in this working tree (confirmed via `git status`), so these are pre-existing bugs in that module, not a T-19 regression. Final suite state: **433/439 passing**, 6 failures both accounted for.

---

## 4. Production deployment status, and a gap this wave found and closed

Both migrations (`034`, `035`) were applied directly to the real Neon production branch (`br-rough-forest-aif4a3vf`) and every outcome was verified with a direct query, not assumed from the migration exiting cleanly.

**A significant gap was discovered while shipping T-19**: local `master` had **30 commits** — every commit for T-17, T-18, and T-19 — that had never been pushed to `origin/master` on GitHub. The database side of "applied to production" was real (the Neon MCP tool writes directly to the database, independent of git), but the *application code* side was not — meaning T-18's API routes, for instance, likely never existed in the actually-deployed Vercel app despite their database tables being live for a day. This was caught by checking `git log --oneline origin/master..master`, not by assumption. Fixed by merging T-19 into master and pushing all 30 commits (`147e92f..35d9903`, a clean fast-forward, no divergence) plus one follow-up tracker commit (`73c750e`). Vercel's build for `73c750e` is confirmed `state: success`.

**Lesson for future waves**: "applied to production" for a Neon-migration-plus-code module has two independent halves — verify both. A clean Neon `run_sql` against the production branch says nothing about whether the corresponding code has ever reached `origin/master`, let alone been deployed. Check `git log origin/master..master` (or equivalent) before assuming code parity, especially in a repo where multiple sessions may be committing to local branches without pushing.

---

## 5. What's explicitly NOT done yet

- **T-19's API endpoints** (`GET/POST /api/tenants`, `/api/tenants/:id/policy`, `/api/tenants/:id/co-broker-agreements`, `/api/policy-evaluations`) — not built. The data model, seed data, and evaluation logic exist; the HTTP surface doesn't.
- **`evaluatePolicy()` is wired into the Qualifier but strictly in shadow mode — see §6.** Real enforcement needs poster-identity capture at ingestion (the DAT scraper doesn't extract company/MC/DOT yet) before it can safely gate anything.
- **T-18's replay harness and disagreement report** report "no data" honestly, not a bug — there's been no real Retell call traffic on production yet (shadow-drain mode, Pilot 1 not yet live). Re-run both once real calls exist; that's when their output becomes meaningful.
- **Migration 030** (referenced by the base T-19 spec) remains untouched — it's separate, pending, gated work; T-19 did not force it forward.

---

## 6. Qualifier wiring (2026-08-25) — evaluatePolicy() + classifyLoadSource(), shadow-only

The concurrent `e2-01-m1-session1` session shipped its own foundation the same day as T-19 — migration `040_shipper_direct_gate.sql`, `lib/pipeline/load-source-classifier.ts` (`classifyLoadSource()`), `lib/verification/authority-lookup.ts`, and a `poster_registry` seed — under its own base spec, `Engine 2/E2-01_Engine2_Expansion_PRD.md`. That spec's own scope doc marked this as **"Session 1: foundation only"** and explicitly listed "Qualifier F0/F1 wiring" as a separate, not-yet-built "Session 2." This section covers wiring that gap — done the same day, once the foundation landed.

### What was found before writing any code

Wiring `evaluatePolicy()` in turned out to be more than "call an existing tested function": three real constraints surfaced from reading the base PRD (`Engine 2/E2-01_Engine2_Expansion_PRD.md §4.2, §4.6-§4.9`, itself an untracked file — see the note in §3 of this doc about untracked spec files, the same pattern recurs here) before implementing:

1. **Poster identity isn't captured anywhere yet.** `classifyLoadSource()` needs a poster's company name/MC#/DOT#, but no ingest path populates it — the DAT scraper's detail-panel expansion for MC#/company name is a separate, not-yet-built prerequisite (`E2-01 §4.2`). Wiring the gate in *enforcing* mode today would see empty poster identity on every real scraped load, classify it `unresolved`/`poster_identity_missing`, and reject essentially the entire live pipeline.
2. **`classifyLoadSource()` and `evaluatePolicy()` are complementary, not interchangeable.** `classifyLoadSource()` returns a three-way verdict (accept/reject/**review**, with a whole human-escalation workflow attached — `E2-01 §4.7`); `evaluatePolicy()` is binary (accept/reject only). They answer different questions: *who is this poster* (identity/fraud) vs. *does this tenant's policy allow working a load from that poster* (business rule, including geographic scope). Both needed to run, not one replacing the other.
3. **The base PRD's own §4.11 already anticipated this exact reconciliation**, calling it "T-19b": swap `classifyLoadSource()`'s env-built policy object for T-19's `tenant_policies`/`evaluatePolicy()`. In practice the shipped `classifyLoadSource()` never took a policy argument at all (simpler than the spec's original sketch), so there was no intermediate env-based version to build and later replace — `evaluatePolicy()` could be wired in directly as the tenant-policy layer from day one.

Given (1), enforcing now was ruled out. The chosen design — confirmed with the user before writing code — was **shadow-only**: classify and evaluate every load, write the results, but never let them affect qualify/disqualify. Full enforce-mode (the reject/review/escalation routing from `E2-01 §4.6-§4.7`) was deliberately *not* built in this pass — that's a separate, larger piece of work (a new `exceptions`-bridge review flow, a `POST /api/pipeline/loads/:id/resolve-source` route) that wasn't what was asked for.

### What was built

- **`lib/workers/qualifier-worker.ts`** — `runShadowSourceClassification()`, called at the top of `process()` for every load, gated by `SHIPPER_DIRECT_GATE_ENABLED` (default `false`/unset — current behavior is byte-for-byte unchanged unless someone deliberately flips this). When enabled: resolves `poster_registry`/co-broker-agreement/authority-lookup inputs, calls `classifyLoadSource()`, derives `isDirect` from the resulting class (`shipper_direct` → true, everything else → false), and calls `evaluatePolicy()` with Myra's tenant id. The whole thing is wrapped in try/catch at two levels — a classification or policy-evaluation failure is logged and skipped, **never** thrown, so it can never look like a qualification failure.
- **`persistShadowClassification()`** — writes `load_source_class`/`_method`/`_confidence`/`_evaluated_at`/`_evidence` and a human-readable `qualification_detail` summary into the columns migration `040` already added to `pipeline_loads`, in a separate `UPDATE` from the real qualify/disqualify write so a persistence failure there can't roll back the real decision either.
- **`lib/tenants/get-myra-tenant-id.ts`** — small shared resolver (`SELECT id FROM tenants WHERE slug='myra'`), added because this is the second TS call site (after `margin-floor.ts`) that needs Myra's tenant id; same "never hardcode it" discipline as §2 above.
- **`QualifyJobPayload`** gained optional `posterCompanyRaw`/`posterMcNumber`/`posterDotNumber`/`isManualImport` fields — all unpopulated today, but present so that whenever the scraper-capture prerequisite lands, this code needs zero changes, only a payload producer that fills them in.
- **`.env.example`** — documents `SHIPPER_DIRECT_GATE_ENABLED` and `FMCSA_QC_WEBKEY`.

### Tests

Two new cases in `__tests__/pipeline/qualifier.test.ts`, both against a disposable Neon branch: gate disabled proves the pre-existing qualify/disqualify tests are completely unaffected (`sourceClassification` is `null`, no columns written); gate enabled proves the whole chain runs for real — `classifyLoadSource()` correctly returns `unresolved`/`poster_identity_missing` for a load with no poster identity, `evaluatePolicy()` genuinely executes and rejects (verified by querying a real `authority_evaluations` row under the `policy_engine` agent, not just trusting the in-memory return value), and — the point of the whole exercise — the load **still qualifies normally**, because the existing filter chain is untouched.

### A pre-existing bug found along the way, unrelated to this change

Running the full regression suite surfaced `agent_calls.call_type` now carries a check constraint (`CHECK (call_type IN ('outbound_shipper', 'outbound_carrier'))`) that several T-17 test fixtures violate by inserting `'negotiation'` — `events-triggers.test.ts` and two cases in `events-views.test.ts`. Confirmed via `git status` that neither file was touched by this change; this predates it and is a latent schema/fixture mismatch worth fixing separately. Final suite state: **483/493 passing**, all 10 failures pre-existing (this one, plus the already-documented `ranker.test.ts` timeout and `cost-calculator.test.ts` arithmetic mismatches from §3).

### What real enforcement still needs

1. **Poster-identity capture at ingestion** (`E2-01 §4.2`) — DAT scraper detail-panel expansion for MC#/company name; official-API adapter field mapping; CSV import attestation. None of this exists yet.
2. **Review/escalation routing** (`E2-01 §4.6-§4.7`) — the `exceptions` bridge, SLA expiry, and the `resolve-source` API route for the human-review loop that `classifyLoadSource()`'s `review` verdict needs somewhere to go.
3. Flipping `SHIPPER_DIRECT_GATE_ENABLED=true` with real enforcement (not just shadow logging) is then a follow-up change to `qualifier-worker.ts` — the classification and policy-evaluation plumbing built here is already correct end-to-end and doesn't need a re-wire, only a decision about what to *do* with a reject/review verdict instead of just logging it.

## 7. Where things live

| What | Path |
|---|---|
| T-18 migration | `MyraTMS/scripts/034-agent-runtime-governance.sql` |
| T-19 migration | `MyraTMS/scripts/035-t19-tenant-policy-model.sql` |
| T-18 core logic | `MyraTMS/lib/governance/{types,evaluate,evaluate-authority,api-helpers}.ts` |
| T-19 core logic | `MyraTMS/lib/governance/{policy-types,evaluate-policy,evaluate-policy-db}.ts` |
| Margin floor (T-19) | `MyraTMS/lib/tenants/margin-floor.ts` |
| Myra tenant id resolver | `MyraTMS/lib/tenants/get-myra-tenant-id.ts` |
| T-18 seed / ops scripts | `MyraTMS/scripts/t18_seed_governance.ts`, `t18_replay_shadow_evaluation.ts`, `t18_disagreement_report.ts` |
| T-17 backfill (fixed by T-19) | `MyraTMS/scripts/t17_backfill_events.ts` |
| E2-01 M1 foundation (shipper-direct gate) | `MyraTMS/scripts/040_shipper_direct_gate.sql`, `MyraTMS/lib/pipeline/load-source-classifier.ts`, `MyraTMS/lib/verification/authority-lookup.ts` |
| Qualifier shadow-gate wiring (§6) | `MyraTMS/lib/workers/qualifier-worker.ts` (`runShadowSourceClassification`, `persistShadowClassification`) |
| Tests | `MyraTMS/lib/governance/__tests__/`, `MyraTMS/__tests__/governance/`, `MyraTMS/lib/tenants/__tests__/`, `MyraTMS/__tests__/pipeline/qualifier.test.ts` |
| Module checklist (living doc) | `Engine 3/docs/superpowers/plans/completion.md` |
