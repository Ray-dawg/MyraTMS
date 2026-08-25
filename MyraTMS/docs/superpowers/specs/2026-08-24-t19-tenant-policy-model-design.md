# T-19 Tenant & Policy Model — Redesigned Implementation Design

**Date:** 2026-08-24
**Base spec:** `Engine 3/T19_Tenant_Policy_Model.md` (still authoritative for the *policy evaluation logic* — the load-source rule table in §5, the escalation/audit reuse of T-18's `authority_evaluations`, and the overall shadow-validation philosophy). It is **not** authoritative for the data model in §4 — that section assumes `tenants`/`tenant_users` don't exist. They do, with a materially different shape, built for a different purpose (platform/billing relationship, not freight business model). This document replaces §4 and adjusts scope accordingly.

## Why this document exists

Two rounds of investigation (forked, reported to Patrice directly, both resolved by explicit decision) found that T-19's premises were wrong in three separate, consequential ways: the tables it wants to create already exist with an incompatible shape; T-17/T-18's `tenant_id DEFAULT 1` already mislabeled production data under the wrong tenant; and the acceptance criterion tying `evaluatePolicy()` to "Qualifier Filter 3" has nothing to validate against because no such filter exists anywhere in the live pipeline. This document is the reconciliation, with every open question resolved by Patrice rather than assumed.

## Decisions (resolved with Patrice, 2026-08-24)

### 1. Reuse `tenants` and `tenant_users` as-is. Do not create new tables with those names.

Real schema (`scripts/027_multi_tenant_foundation.sql`):

```sql
tenants(id BIGSERIAL, slug, name, type CHECK IN ('operating_company','saas_customer','internal'),
        status, parent_tenant_id, billing_email, primary_admin_user_id, created_at, updated_at, deleted_at)
tenant_users(tenant_id BIGINT, user_id TEXT, role CHECK IN ('owner','admin','operator','driver','viewer','service_admin'),
             is_primary, joined_at, PRIMARY KEY (tenant_id, user_id))
```

`id=1` is `_system`/internal, `id=2` is `myra`/operating_company — confirmed live. `tenants.type` answers "what kind of platform/billing relationship"; it is not reused for the freight-business-model axis (decision 3). Every new FK in this module points at `tenants(id)` (BIGINT), never a new tenant table.

### 2. `tenant_id` mislabel: backfill-correct, resolve by slug going forward, never a hardcoded literal again

All of T-17's `events` and T-18's `authority_envelopes`/`authority_evaluations`/`escalations` currently default and were seeded with `tenant_id=1` (`_system`), not `tenant_id=2` (`myra`). Fixed via:

- New SQL helper, defined once: `fn_myra_tenant_id() RETURNS BIGINT AS $$ SELECT id FROM tenants WHERE slug = 'myra' $$ LANGUAGE sql STABLE;` — the single source of truth for "which tenant is Myra," resolved by slug, not a number anyone has to remember.
- Every hardcoded literal `1` used as a tenant_id default across T-17/T-18 is replaced with a call to this function: the `events.tenant_id` column default, `fn_insert_event`'s own `COALESCE(p_tenant_id, 1)` fallback, all 10 trigger call sites in `033-event-data-layer.sql`, the `scraper_runs` trigger's `COALESCE(NEW.tenant_id, 1)`, the matching 10 call sites in `scripts/t17_backfill_events.ts`, the 3 table defaults in `034-agent-runtime-governance.sql` (`authority_envelopes`, `authority_evaluations`, `escalations`), and the 1 literal in `scripts/t18_seed_governance.ts`.
- One-time backfill: `UPDATE events SET tenant_id = fn_myra_tenant_id() WHERE tenant_id = 1;` and the equivalent for the three T-18 tables, run once as part of this module's migration.
- Logged to the existing `tenant_audit_log` table (event_type `tenant_id_backfill_corrected`) rather than inventing a new log — this is exactly the kind of system-level tenant event that table already catalogs.

Scope boundary: the sibling `scraper/` project's own `scraper_runs.tenant_id DEFAULT 1` (in `scraper/migrations/001_scraper_tables.sql`) is a separate deploy unit and out of scope here — only the T-17 trigger's *read* of that column (`COALESCE(NEW.tenant_id, 1)`) is being fixed, not the scraper's own default.

### 3. Freight-business-type classification: new column, not `tenant_config`

Checked `tenant_config`'s actual usage pattern (`lib/tenants/config-schema.ts`, `lib/tenants/defaults.ts`): it's a closed keyspace of ~35 individually Zod-validated scalar keys — currency/locale defaults, operational numeric thresholds, branding strings, encrypted credentials. `isKnownConfigKey()` rejects anything not explicitly declared. Every existing key is a *setting*, never a *structural classification* — that role already belongs to `tenants.type` as a real column.

Broker/Dispatcher/Carrier/Acquired-Opco is the same *kind* of thing `tenants.type` is (an identity classification), just a different axis (freight business model vs. platform relationship) — so it gets the same treatment: a new column, not a `tenant_config` entry.

```sql
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS freight_business_type VARCHAR(20)
  CHECK (freight_business_type IN ('broker', 'dispatcher', 'carrier', 'acquired_opco'));
```

Nullable — most existing/future tenants created for non-freight purposes (e.g. a future `saas_customer` that isn't a trucking business) legitimately have no value here. Myra is backfilled to `'broker'`.

### 4. New tables: `tenant_type_policy_templates`, `tenant_policies`, `co_broker_agreements`

These genuinely don't exist anywhere yet — built per the base spec §4.2–§4.4, with `tenant_id` FKs corrected to `BIGINT REFERENCES tenants(id)` (matching the real table) instead of the base spec's assumed `INTEGER`. `tenant_type_policy_templates` is keyed by `freight_business_type`, not a redefinition of `tenants.type`. Seed data is the base spec's E3-00 §4.2 table verbatim (Broker/Dispatcher/Carrier/Acquired-Opco defaults), and Myra's `tenant_policies` v1 row is seeded to match T-05's actual Pilot 1 behavior: domestic-Canada-only, per `qualifier-worker.ts`'s real freshness/geography handling (the base spec's claim that this also matches "shipper-direct required" is addressed in decision 6 below — not assumed here).

`tenant_users` is **not** rebuilt — the base spec's §4.5 proposal is fully superseded by the real table (decision 1). Any RBAC concept T-19's API endpoints need (e.g. "who can write a tenant policy") reads the real `tenant_users.role`, not a new column.

### 5. Migration 030: left pending, not forced

Checked its real activation gate against `Engine 2/docs/superpowers/plans/completion.md`. Verbatim condition (`030_engine2_tenanting.sql.PENDING:6-10`): *"Engine 2 v1 in production for ≥24 hours with no critical incidents AND the active Engine 2 plan reports completion in completion.md with all checkmarks."* Neither is met — `completion.md:8` states **"Pre-production, not yet shipping,"** with open items (webhook signature verification unconfirmed on a genuine Retell webhook, a walk-load pileup bug open, Phase 6A/6B checklist items still unchecked). This module does not touch that file or its 10-table scope. `loads`/`carriers`/`shippers` already have `tenant_id` via migration 028 (dynamic slug resolution, not touched here either) — T-19 has no work to do on any of the six tables the base spec's §4.6 listed.

### 6. `evaluatePolicy()`: build the decision engine and data model now; defer only its validation target

The base spec's acceptance criterion 6 wants `evaluatePolicy()` to reproduce "Qualifier Filter 3" with 100% agreement. Confirmed via direct code investigation (both Scanner's `ingestRawLoads()` and all six of the Qualifier's actual filter conditions, not just their reason strings) that **no shipper-direct/broker-posted enforcement exists anywhere in the live pipeline** — Filter 3 is lane coverage, not load source. This is being tracked and fixed as a separate, live-system compliance gap (not an Engine 3 module) in parallel.

Scope split for this module:
- **Build now:** the pure `evaluatePolicy()` decision function (mirrors T-18's `applyEnvelope()` pattern — geographic scope check, load-source-policy check against the four documented rule types, co-broker-agreement lookup), the full data model and seed data (decisions 3–4), and the read/write API (§7 of the base spec). Unit tests target the pure function's rule logic directly (geographic reject, shipper-direct accept, broker-posted-with-agreement accept, broker-posted-without-agreement reject, expired-agreement reject) — these test the rules as documented in E3-00 §4.2, independent of what the live Qualifier does or doesn't do today.
- **Not built yet:** the replay harness (base spec §6) and acceptance criterion 6's validation-against-live-filter step. Once the parallel compliance-gate work lands (wherever it ends up — Scanner or Qualifier), `evaluatePolicy()`'s validation target gets pointed at that real implementation instead of a non-existent one. This is a genuinely open item, not quietly dropped — tracked in the completion tracker as blocked on that other work.

### 7. Threshold consolidation (the `auto_book_profit_threshold_cad` cleanup)

Separate from the tenant_id mislabel, but touching the same production surface, so handled in the same migration pass. Real finding: `tenant_config` already has `margin_floor_cad`/`margin_floor_usd` keys — seeded to **150/110**, which is *also* wrong; the value actually driving `auto_book_eligible` in production is **270 CAD / 200 USD**, hardcoded independently in `compiler-worker.ts:208`, `qualifier-worker.ts:251`, and `researcher-worker.ts:436`.

Fix:
- `UPDATE tenant_config SET value = '270' WHERE tenant_id = fn_myra_tenant_id() AND key = 'margin_floor_cad';` and `'200'` for `margin_floor_usd` — correcting the existing keys to match reality, not adding new ones.
- New shared helper `lib/tenants/margin-floor.ts` — `getMarginFloor(currency: 'CAD' | 'USD'): Promise<number>`, a single `SELECT value FROM tenant_config WHERE tenant_id = $1 AND key = $2` behind one function, so three files stop each rolling their own query.
- All three worker files call this helper instead of their local `currency === 'CAD' ? 270 : 200` literal. A before/after test asserts the effective value is unchanged for both currencies — this is a refactor, not a behavior change.
- `tenant_config.auto_book_profit_threshold_cad` (200, unused) and `.env.local`'s `AUTO_BOOK_PROFIT_THRESHOLD` (999999, unused) are both removed.
- `scripts/t18_seed_governance.ts`'s voice envelope now reads `getMarginFloor('CAD')` for `policies.margin_floor_pct`-equivalent and for `policies.auto_book_profit_threshold_cad`, instead of carrying a frozen copy of the dead env var — so it can't drift from live behavior again. (T-18's envelope is otherwise unchanged; this is a one-line seed-source swap, not a schema change to `authority_envelopes`.)

## Explicitly unchanged from the base spec

The load-source policy rule table (E3-00 §4.2: shipper_direct_or_coBroker / broker_or_shipper_direct / any / inherit), the reuse of T-18's `authority_evaluations` for policy-evaluation logging (§5 — a policy decision and an authority decision are the same kind of record), the write-boundary rules, the portability notes, and the overall shadow-only philosophy (§3) — all carry forward unchanged.

## Explicitly out of scope for this pass

Wiring `evaluatePolicy()` into `qualifier-worker.ts` (T-19b, same as before). The replay harness and acceptance criterion 6 specifically (deferred per decision 6, not dropped). The double-brokering live-pipeline fix itself — tracked separately, will inform decision 6's eventual resolution.
