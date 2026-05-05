# ADR-004 — Backwards-Compatibility & Migration Strategy

| | |
|---|---|
| **Status** | **Approved 2026-05-01** (Patrice resolution round 2) |
| **Date** | 2026-05-01 |
| **Deciders** | Patrice Penda |
| **Drafter** | Claude (Opus 4.7) |
| **Depends on** | [ADR-001](./ADR-001-tenant-isolation.md), [ADR-002](./ADR-002-tenant-resolution.md), [ADR-003](./ADR-003-feature-gating.md) |
| **Companion docs** | [RLS_ROLLOUT.md](./RLS_ROLLOUT.md) (live per-batch schedule for M3), [SESSION_TIME_LOG.md](./SESSION_TIME_LOG.md) (per-session time tracking) |

## Context

MyraTMS is **already in production** (per Patrice's Answer 6). Tenant 1 (Myra Logistics) operates daily — loads dispatched, invoices generated, drivers tracking, Engine 2 v1 about to validate. The multi-tenant retrofit cannot have a maintenance window longer than ~2 hours, cannot break in-flight workflows, and cannot lose data on rollback.

The mega-prompt prescribes:
- Phase 1 introduces `tenant_id` as nullable with `DEFAULT 1`
- Phase 2 makes `tenant_id` `NOT NULL`
- Phase 3 deletes single-tenant code paths
- Each phase passes a regression suite before proceeding

This ADR formalizes that direction into a **5-phase expand-contract migration** that addresses two gaps in the prompt:
1. The `DEFAULT 1` strategy creates an in-between state where new writes default to 1 while application code may not yet be passing tenant_id explicitly. Need explicit ordering.
2. Engine 2 tables are deferred (Rule A) — their migration follows the same 5-phase pattern but on a different timeline.

## Decision

### Five migration phases (expand-contract)

```
PHASE M1 — EXPAND (additive, fully backwards-compatible)
  ├─ M1a: Create foundation tables (tenants, tenant_config, ...). Seed Tenant 0/1.
  ├─ M1b: ADD COLUMN tenant_id BIGINT NOT NULL DEFAULT 1 to every Cat A table.
  │       Backfill via the DEFAULT itself (instant for existing rows).
  ├─ M1c: ADD composite indexes (tenant_id, hot_column).
  ├─ M1d: CREATE RLS policies on every Cat A table — but DO NOT ENABLE yet.
  └─ Gate: Phase 1.6 isolation test suite passes against staging clone.

PHASE M2 — TENANT-AWARE CODE LANDS (still backwards-compatible at the DB)
  ├─ M2a: Deploy middleware.ts with tenant resolution.
  ├─ M2b: Deploy lib/db/tenant-context.ts with withTenant().
  ├─ M2c: Refactor all 90 API routes to use withTenant().
  ├─ M2d: JWT shape change (add tenantId, accept tokens without it as tenant 1 fallback).
  └─ Gate: Production smoke tests for 24h. New writes carry explicit tenant_id; legacy writes still default to 1.

PHASE M3 — RLS ENFORCEMENT (DB becomes authoritative)
  ├─ M3a: Enable RLS in batches per the schedule in RLS_ROLLOUT.md.
  │       Default cadence: 1 batch per day. ~12 working days for TMS-core.
  │       Acceleration to 2 batches/day allowed after 3 clean days; Patrice arbitrates.
  │       Hot-path tables (carriers batch, loads batch) stay isolated regardless of streak.
  │       Each batch: pre-flight code audit, staging test, enable in transaction, smoke test, monitor 4h.
  ├─ M3b: After all tables RLS-enabled, run cross-tenant leak audit (Phase 7.3).
  └─ Gate: Zero cross-tenant leak findings AND <10% performance regression for 7 days.

PHASE M4 — CONTRACT (remove backwards-compat hatches)
  ├─ M4a: ALTER TABLE x ALTER COLUMN tenant_id DROP DEFAULT (force application to provide).
  ├─ M4b: Reject JWTs without tenantId claim (was: default to 1).
  ├─ M4c: Remove any code paths that handled missing tenant context (e.g., the `if (!ctx.tenantId) return tenant1Default()` helpers).
  ├─ M4d: Tenant 2 (Sudbury) provisioned and operational.
  └─ Gate: 7 days of clean operation post-Tenant-2-provisioning.

PHASE M5 — ENGINE 2 (deferred per Rule A)
  ├─ Trigger: Engine 2 v1 in production for ≥24h with no incidents.
  ├─ M5a–d: Same 4-phase pattern applied to pipeline_loads, agent_calls, etc.
  └─ Gate: same as M1–M4 but for Engine 2 tables.
```

### Phase-by-phase rollback windows

| Phase | Rollback action | Data loss risk |
|---|---|---|
| M1 | Drop `tenant_id` column (it has only DEFAULT 1 values, safe to remove). RLS policies haven't been enabled, so dropping them is no-op. | None |
| M2 | Revert application deploy to previous Vercel deployment. Schema unchanged. | None |
| M3 (per table) | Disable RLS on the offending table: `ALTER TABLE x DISABLE ROW LEVEL SECURITY`. Application keeps working because it provides tenant_id explicitly. | None — RLS disable is reversible without data movement |
| M4 | Re-add DEFAULT 1 on tenant_id, accept tokens without tenantId. **Past the point of no return for clean code state** but data is safe. Rolling back means accepting some legacy code paths return. | None for data; some development time lost |
| M5 | Same as M1–M4 but for Engine 2 tables only. TMS-core operations unaffected. | None |

### Rollback contract for every migration script

Every migration `0NN_description.sql` ships with a paired `0NN_description_rollback.sql` that:
1. **Runs against a staging clone of production** before the forward migration runs in prod
2. Restores schema to pre-migration state (using `IF EXISTS` guards for idempotency)
3. Includes data-validation queries that assert row counts match pre/post

Example pairing:
- `028_add_tenant_id.sql` adds the column
- `028_add_tenant_id_rollback.sql` drops it (with row-count assertion that no rows have `tenant_id != 1`)

Rule: **A forward migration without a tested rollback does not get applied to production.**

### Coordinated deploys (DB and code)

Phase M2 (code refactor) is the trickiest because schema and code change together. Deploy order:
1. Apply M1 migrations in production. Production code (still single-tenant) keeps working — `tenant_id = 1` default lets any new writes succeed.
2. Deploy M2 code to **preview/staging** first. Verify against staging Postgres.
3. Deploy M2 code to **production** via Vercel. The new code provides `tenant_id` explicitly via `withTenant()`. Legacy code paths that haven't been refactored yet still rely on the DEFAULT.
4. Monitor for 24h.
5. Begin M3 (per-table RLS enable) — no more code changes needed.

**Vercel revert path**: at any point, `vercel rollback <previous-deployment-id>` restores M1's schema-compatible code. The DB schema is forwards-compatible with both M1-era and M2-era code.

### Regression suite gate (per phase)

Before proceeding from one phase to the next, the regression suite must pass. Defined in Phase 1.6 (`tests/multitenant/isolation.test.ts`) and Phase 7.1 (`tests/multitenant/end-to-end.test.ts`):

**M1 → M2 gate (run on staging):**
- Foundation tables exist, Tenant 0 + 1 seeded
- Every Cat A table has `tenant_id` column
- Every existing row has `tenant_id = 1`
- RLS policies exist but not enforced (visible in `pg_policies`)
- All existing API routes still pass smoke tests (no behavior change)

**M2 → M3 gate (run on production):**
- All 90 API routes refactored to use `withTenant()` (audited in `API_REFACTOR_LOG.md`)
- New JWTs include `tenantId`; legacy JWTs still accepted with default
- Multi-tenant integration tests pass on staging clone of prod
- 24h of clean production operation

**M3 → M4 gate (run on production):**
- Every Cat A table: RLS enabled, cross-tenant query returns 0 rows in tests
- Performance benchmark: <10% regression on hot-path queries
- Phase 7.3 security audit: 0 cross-tenant leak findings
- 7 days of clean operation

**M4 → M5 gate:**
- Tenant 2 (Sudbury) provisioned and operational for ≥7 days
- Engine 2 v1 in production for ≥24h with no incidents (also a Rule A precondition)

### Coordinated rollback for partial Phase M2

If M2 code deploy reveals a critical bug at hour 6 (mid-deploy):
1. Vercel rollback to M1-compatible deployment (≤5 min). Schema is unchanged — works.
2. Diagnose. If the bug is in `withTenant()` plumbing or middleware, fix and redeploy.
3. If the bug is in a specific route handler, narrow the deploy: revert that route's changes only, leave middleware/db-context changes.

**No DB rollback is needed** in M2 because the schema is forwards-compatible.

### Engine 2 (M5) coordination

Engine 2 tables (per `TENANTING_AUDIT.md` §3) get their `tenant_id` migration in Phase M5, triggered when:
- Engine 2 v1 is in production for ≥24h with no critical incidents
- AND the active Engine 2 plan (`Engine 2/docs/superpowers/plans/2026-04-30-engine2-end-to-end.md`) reports completion (`completion.md` updated with all checkmarks)

If the active Engine 2 plan adds columns or tables in flight, M5 holds until those land. Schema-conflict arbitration per Patrice's Rule E.

The Railway scraper (T-04A) is in scope for Phase M5: `pipelineLoads` writes from the scraper need to include `tenant_id = 1` during M5a (DEFAULT covers this), then explicit `tenant_id` in the scanner's payload after M5b.

## Consequences

### Positive

- **Maintenance window stays small.** Each phase is independently deployable. The longest single migration (M1b adding columns to 24 tables with DEFAULT) is sub-second per table; total downtime negligible.
- **Forward-only data flow.** No data migration in either direction. `tenant_id = 1` is the correct value for every existing row (Tenant 1 = Myra primary).
- **Rollback at every phase** until M4. The point of no return is removing the DEFAULT — by then, the system has soaked for 7+ days under RLS enforcement.
- **Explicit gates.** Each phase has a measurable pass/fail. No phase begins without the prior gate green.
- **Engine 2 protected.** M5 is sequenced after Engine 2 v1 stabilizes — protects the most sensitive subsystem.
- **Per-table RLS rollout** (M3a) limits blast radius. If RLS on `loads` causes an unexpected query failure, only `loads` is affected; other tables unaffected.

### Negative

- **Long calendar time.** M3 takes ~28 days (one table per day). M4 has a 7-day soak. M5 waits on Engine 2 v1 + 24h. Total wall-clock from session 2 start to "fully multi-tenant" is ~6–8 weeks even with autonomous execution.
- **Drift risk during the soak periods.** Active development continues during the migration; new code must respect the in-progress state (e.g., must use `withTenant()` even though RLS isn't enabled yet). Mitigated by: lint rule + code review checklist (Phase 9.1).
- **Tenant 2 (Sudbury) provisioning is the M4 gate.** If Sudbury isn't ready, M4 stalls. If Sudbury IS ready and operates for 7 days cleanly, that's the proof point that triggers final cleanup.
- **Per-table RLS enable cadence (1/day for 28 days)** is slow but safe. Could be accelerated to 2–4/day for low-traffic tables (e.g., `fuel_index` is Cat B, doesn't need RLS at all; `delivery_ratings` is low-volume). Documented as an acceleration option for Patrice.
- **Two parallel migration timelines** (M1–M4 for TMS-core, M5 for Engine 2). Coordination overhead, but explicit and bounded.

### Neutral

- The 5-phase pattern is just classic expand-contract. No novel sequencing risk.

## Alternatives considered

### Big-bang migration (one weekend, everything at once)

**Rejected.** A single deploy that adds tenant_id, refactors 90 routes, enables RLS, and removes legacy paths has no rollback story past the first hour. Production cannot tolerate a discovery-of-bug followed by 4-hour rollback window.

### Per-tenant rollout (Tenant 1 stays single-tenant; new tenants are multi-tenant)

**Rejected.** Two operating modes in one codebase forever. Maintenance burden grows without bound. The mega-prompt's intent is to make the codebase uniformly multi-tenant.

### Skip the M3 per-table RLS rollout (enable all at once)

**Rejected as default**, available as acceleration. Per-table rollout limits blast radius if a policy bug exists. Trade-off: 28 days vs. 1 day. We pay the time for the safety. Patrice can override per-table for low-risk tables.

### Migrate writes first, reads later

**Considered and rejected.** Conventionally safer (writes converge to new shape, reads still work via union views). But our case is different: `WHERE tenant_id = X` filters work whether `tenant_id` was written explicitly or via DEFAULT. No need for the intermediate state.

### Use Postgres `INHERITS` for tenant tables (legacy approach)

**Rejected.** Table inheritance has known issues with constraints, indexes, and replication. Out of fashion for good reasons.

## Edge cases

### Existing rows with `tenant_id = 1` after Tenant 2 provisions

When Tenant 2 (Sudbury) is created, all existing data still says `tenant_id = 1`. This is correct — Sudbury starts with empty tables. Onboarding wizard (Phase 3.2) handles initial data import for new tenants.

### A user belongs to Tenant 1 + Tenant 2 (Sudbury staff)

`tenant_users` has two rows for that user. JWT carries `tenantIds: [1, 2]` and `tenantId` = whichever they chose at login. Per ADR-002 §Login flow.

### A `service_admin` query needs to backfill or fix data

Use `asServiceAdmin('reason', tx => ...)` per ADR-001. Logged automatically. Reserved for emergency operational fixes.

### Backup taken during M1b (column add) — restore implications

Neon's PIT restore captures the DB state at the moment. If you PIT-restore to before M1b, the `tenant_id` column doesn't exist — application code that depends on it (M2-era) will fail. Mitigation: when running PIT restores during the migration period, also pin a corresponding Vercel deployment ID so DB and code roll back together. Phase 8.2 production migration plan documents the deployment-pinning protocol.

## Out-of-scope decisions deferred

- **Per-tenant feature flag rollouts** (e.g., enable a new TMS feature for Tenant 5 first). Deferred — `feature_overrides` JSONB already supports this primitive; UI and process come later.
- **Live migration of an existing customer onto a new schema** (migrate from Option A to Option B per ADR-001). Defer until the trigger fires.
- **Schema-version checking at boot** (refuse to start if app code expects schema vN but DB is at vN-1). Future deliverable; not Phase 1.

## Validation

This ADR is satisfied when:
1. Phase 1 migration scripts ship with paired rollbacks, all tested on staging clone.
2. M1 → M2 → M3 → M4 → M5 sequencing is documented in `PRODUCTION_MIGRATION.md` (Phase 8.2) with go/no-go criteria per phase.
3. Phase 7.1 test suite proves rollback from each phase works.
4. Tenant 2 (Sudbury) operates for 7 days post-M4, demonstrating production readiness.
