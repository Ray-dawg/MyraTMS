# HANDOFF.md

> **Purpose:** Single-page entry point for whoever picks the
> multi-tenant rollout back up. Read this first.
>
> **Status of the rollout at handoff (2026-05-07):** Sessions 1–8
> complete on the master branch. Code is multi-tenant-ready end-to-end.
> **Migrations 027–031 are NOT yet applied to the production Neon
> branch.** That apply is the next operational gate.

## §1 — TL;DR

What changed in the codebase across Sessions 1–8:

- **Schema:** `tenants`, `tenant_users`, `tenant_subscriptions`,
  `tenant_audit_log`, `tenant_config`, `tenant_usage` tables added.
  `tenant_id BIGINT NOT NULL` column added to 26 Cat A tables. RLS
  policies CREATED on 30 tables (NOT yet enabled — that's Phase M3).
- **App:** every tenant-scoped DB read/write goes through
  `withTenant(tenantId, async (client) => …)` instead of `getDb()`.
  JWT carries `tenantId` / `tenantIds` / `isSuperAdmin`. Middleware
  injects tenant headers per ADR-002.
- **Admin:** `/admin/tenants`, `/admin/tenants/[id]/onboard`,
  `/admin/settings`, `/admin/config/[key]` API surface for managing
  tenants + per-tenant config. Super-admin-only.
- **Features:** three-layer gating per ADR-003 — `lib/features/{index,tiers,gate,loader}`.
  Per-tenant overrides via `tenant_subscriptions.feature_overrides`
  JSONB. Redis-backed usage tracker. UI tier-gates nav items via
  `useFeatures()` (cosmetic; server enforces).
- **Crons:** the 4 in-scope cron handlers iterate active tenants via
  `forEachActiveTenant`. Engine 2 crons (`pipeline-health`,
  `feedback-aggregation`, `pipeline-scan`) are deferred per Engine 2
  Rule A until migration 030.
- **Docs:** [INDEX.md](./INDEX.md) maps every architecture document.
  [PRODUCTION_MIGRATION.md](./PRODUCTION_MIGRATION.md) is the runbook
  for the next operational step.

## §2 — Where to start

Pick the situation that matches:

### "I'm picking this up to push it to production."
1. Read **[PRODUCTION_MIGRATION.md](./PRODUCTION_MIGRATION.md)** end-to-end.
2. Run the staging smoke (STAGING_APPLY.md §5) one more time to confirm
   the staging branch is still green.
3. Schedule the production execution window with Patrice.
4. Apply 027 → 028 → 029 → 031 to the production Neon branch per the
   runbook. Capture LSN + Vercel deployment ID at every step.
5. Promote master to a Vercel preview, point it at the migrated DB,
   smoke-test the routes in PRODUCTION_MIGRATION §4.5.
6. Promote to production.
7. Begin Phase M3 RLS enable per [RLS_ROLLOUT.md](./RLS_ROLLOUT.md).

### "I'm picking this up to keep developing on it."
1. Read **[CODE_REVIEW_CHECKLIST.md](./CODE_REVIEW_CHECKLIST.md)** —
   the rules every new PR must follow during the M3 → M4 soak.
2. Read **[ADR-001](./ADR-001-tenant-isolation.md)** through
   **[ADR-004](./ADR-004-migration-strategy.md)** to understand the
   architectural commitments.
3. Skim **[SESSION_3_SUMMARY.md](./SESSION_3_SUMMARY.md)** through
   **[SESSION_7_SUMMARY.md](./SESSION_7_SUMMARY.md)** for context on
   what was decided session-by-session and why.
4. Check the open items in §4 below before starting new work — some
   are deliberate deferrals; some are hot rocks.

### "I'm picking this up to enable RLS in production."
1. Read **[RLS_ROLLOUT.md](./RLS_ROLLOUT.md)** — batch schedule, per-batch
   workflow, acceleration criteria.
2. Read **[PERFORMANCE_NOTES.md](./PERFORMANCE_NOTES.md)** §7 — index
   audit must pass before flipping the first ENABLE.
3. Confirm migrations 027–031 are applied to production (per §1
   PRODUCTION_MIGRATION.md state at handoff: NOT yet applied).
4. Run the cross-tenant leak audit (`lib/test-utils/cross-tenant-leak.ts`)
   against a staging branch with two seeded tenants. Zero leaks is the
   green light.
5. Flip ENABLE per batch on the production branch following the
   schedule. Monitor `tenant_audit_log` for unexpected events during
   the 4h window after each batch.

### "I'm onboarding a new customer (Tenant 2 / Sudbury / etc.)."
1. Read **[SESSION_4_SUMMARY.md](./SESSION_4_SUMMARY.md)** — admin
   tenant onboarding API surface.
2. Read **[SESSION_6_SUMMARY.md](./SESSION_6_SUMMARY.md)** — UI for
   the same flow.
3. Use the admin UI: `/admin/tenants` → New Tenant → fill slug, name,
   type → onboard wizard → invite owner via auth/invite flow.
4. The owner accepts the invite and lands in their own tenant view.

### "I need to understand a specific code path."
1. **`MyraTMS/lib/db/tenant-context.ts`** is the foundation. Read this
   first. It defines `withTenant`, `asServiceAdmin`, `resolveTrackingToken`,
   `forEachActiveTenant`.
2. **`MyraTMS/lib/auth.ts`** has the JWT shape, `getTenantContext` /
   `requireTenantContext` / `requireSuperAdmin`.
3. **`MyraTMS/lib/features/`** has the three-layer gating model.
4. **`MyraTMS/lib/usage/tracker.ts`** has the Redis usage counters.
5. **`docs/architecture/API_REFACTOR_LOG.md`** is the per-route audit
   trail — find any route's tenant-scoping treatment there.

## §3 — Migration phase status

Per [ADR-004](./ADR-004-migration-strategy.md), the rollout has 5
operational phases. Today (2026-05-07):

| Phase | What | Status |
|---|---|---|
| M1 | Foundation tables (027) + tenant_id column with DEFAULT (028) | 🔵 STAGING ONLY |
| M2 | App code uses withTenant + JWT carries tenantId | ✅ CODE COMPLETE on master |
| M3 | RLS ENABLE per batch | ⬜ NOT STARTED |
| M4 | Drop DEFAULT, reject JWTs without claim, Tenant 2 7-day soak | ⬜ NOT STARTED |
| M5 | Engine 2 tenanting (migration 030, rename + apply) | ⬜ NOT STARTED |

The handoff state: code-complete, staging-validated, production-not-yet-deployed.

## §4 — Open items (the things to decide / build next)

### Operational gates (no code, decisions only)

| # | Item | Owner |
|---|---|---|
| 1 | Schedule production execution window for migrations 027–031 | Patrice |
| 2 | Apply migration 030 (Engine 2 tenanting) — needs Engine 2 v1 in prod for ≥ 24h first | Engine 2 stream + Patrice |
| 3 | Phase M3 RLS enable batch cadence — default 1/day, accelerate to 2/day after 3 clean days | Operator + Patrice |
| 4 | Tenant 2 (Sudbury) provisioning timeline | Business + Operator |
| 5 | Resolve the 5 pre-existing Engine 2 cost-calculator test failures (numeric drift; not multi-tenant scope) | Engine 2 stream |

### Code follow-ups (deferred deliberately)

| # | Item | Tracked |
|---|---|---|
| 1 | Daily Redis→tenant_usage aggregation cron | SESSION_5_SUMMARY §3 |
| 2 | Zip-with-attachments tenant export (current is JSON-only) | SESSION_4_SUMMARY §3 |
| 3 | Purge executor cron (storage exists; executor doesn't yet) | SESSION_4_SUMMARY §3 |
| 4 | `user_invites.role` enum widening to mirror tenant_users.role | SESSION_4_SUMMARY §3 |
| 5 | `useUsage()` hook + topbar usage indicator | SESSION_6_SUMMARY §3 |
| 6 | Whitelabel custom-domain UI (Phase 5.3) | SESSION_6_SUMMARY §3 |
| 7 | Super-admin impersonation UI (Phase 5.5) | SESSION_6_SUMMARY §3 |
| 8 | User-search endpoint for owner picker | SESSION_6_SUMMARY §3 |
| 9 | Component tests (TenantProvider, UsageMeter) — needs jsdom + RTL deps | SESSION_6_SUMMARY §3 |
| 10 | Pool max-cap tuning for production concurrency | PERFORMANCE_NOTES §5 |
| 11 | Stripe billing integration (entire scope) | BILLING_DEFERRED.md |
| 12 | Phase 6 warehouse build (replication consumer, dbt models, BI tool) | WAREHOUSE_INTEGRATION_POINTS §9 |

### Drift-watch (things that may rot)

| # | Item | Where to watch |
|---|---|---|
| 1 | `lib/pipeline/db-adapter.ts` `db.sql: any` typing | STACK_DRIFT_REPORT §10.2 — fix when 030 lands |
| 2 | `lib/quoting/geo/distance-service.ts` and `lib/geo/distance-service.ts` duplication | STACK_DRIFT_REPORT §10.1 — Phase 7 perf consolidation |
| 3 | Engine 2 cost-calculator test drift | STACK_DRIFT_REPORT §10.6 |
| 4 | Tier-gated routes returning 500 instead of 403 on unmigrated DBs | SESSION_7_SUMMARY §2.5 — only matters if you run dev against an unmigrated DB |

## §5 — Cumulative time + budget

Per [SESSION_TIME_LOG.md](./SESSION_TIME_LOG.md):

| Sessions | Budget | Actual | Status |
|---|---|---|---|
| 1–8 (this rollout) | 21.5–28h | ~27h | Within tolerance, mid-band |
| Phase M5 (Engine 2 — post-validation) | 2–3h | TBD | Triggers post Engine-2-v1-soak |

The 35-hour structural alarm has not fired. Total budget held.

## §6 — Don't break these invariants

Hard rules across the multi-tenant rollout. If you find code violating
one of these, treat it as a bug.

1. **Every tenant-scoped DB read or write goes through `withTenant`.**
   `getDb()` is for unauthenticated paths (login, public token resolution
   pre-`resolveTrackingToken`) and explicitly-global tables only.
2. **Every cross-tenant escape calls `asServiceAdmin(reason, ...)` with
   a meaningful reason.** No exceptions. The audit log is forensic
   evidence; a meaningless reason is a future-incident time-bomb.
3. **UI hiding is cosmetic, server is authoritative.** Never gate
   security-sensitive behavior in the UI alone. `requireFeature` /
   `requireSuperAdmin` / `requireTenantContext` on the server is the
   actual gate.
4. **`tenant_audit_log` is append-only.** No production code path ever
   UPDATEs or DELETEs from it. The warehouse pipeline relies on this
   property.
5. **Migrations are paired with rollbacks.** Every `XXX_*.sql` has a
   `XXX_*_rollback.sql` and the rollback is idempotent + (where
   appropriate) refuses to run when destructive (e.g. tenant_usage
   rollback refuses if rows present).
6. **Sensitive credentials are never returned in plaintext.** The
   `tenant_config` GET masks via `maskCredential`. Audit log entries
   for sensitive keys record `<encrypted>` for both old and new values.
7. **Engine 2 stays single-tenant until migration 030 lands.** Don't
   convert Engine 2 paths to per-tenant pre-emptively — the schema
   doesn't support it yet (no `pipeline_loads.tenant_id`).

## §7 — Who to ask

| Topic | Source |
|---|---|
| Architectural intent | The ADRs (001, 002, 003, 004) |
| What changed in a session and why | The matching SESSION_X_SUMMARY |
| How a specific feature works | The matching code module's JSDoc + the SESSION summary that introduced it |
| Why a specific decision was made | STACK_DRIFT_REPORT (for "the docs said X, the code does Y") + the matching SESSION summary §2 (for "this approach was chosen because…") |
| When to pick the work back up | This document, §2 |

End of handoff.
