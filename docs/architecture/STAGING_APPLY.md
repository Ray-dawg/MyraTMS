# STAGING_APPLY.md

> **Cadence:** Updated when a new migration is added or the staging procedure changes.
> **Last update:** 2026-05-01 (Session 2 — Phase 1 deliverables)
> **Related:** [ADR-004](./ADR-004-migration-strategy.md), [RLS_ROLLOUT.md](./RLS_ROLLOUT.md)

This document is the operational procedure for applying Phase 1 migrations to a Neon staging branch and running the multi-tenant integration test suite. **Patrice authorization required before any execution.**

## §1 — What's deployed in this Session 2

| Artifact | Path | Status |
|---|---|---|
| Migration 027 — foundation tables | `MyraTMS/scripts/027_multi_tenant_foundation.sql` | Written, NOT applied |
| Migration 027 rollback | `MyraTMS/scripts/027_multi_tenant_foundation_rollback.sql` | Written |
| Migration 028 — add `tenant_id` to 26 Cat A tables | `MyraTMS/scripts/028_add_tenant_id.sql` | Written, NOT applied |
| Migration 028 rollback | `MyraTMS/scripts/028_add_tenant_id_rollback.sql` | Written |
| Migration 029 — RLS policies (CREATE only, NOT enabled) | `MyraTMS/scripts/029_create_rls_policies.sql` | Written, NOT applied |
| Migration 029 rollback | `MyraTMS/scripts/029_create_rls_policies_rollback.sql` | Written |
| Migration 030 — Engine 2 tenanting | `MyraTMS/scripts/030_engine2_tenanting.sql.PENDING` | Placeholder, deferred to Phase M5 |
| `lib/crypto/tenant-secrets.ts` + tests | `MyraTMS/lib/crypto/` | Written, unit tests ready |
| `lib/db/tenant-context.ts` | `MyraTMS/lib/db/` | Written |
| `lib/tenants/defaults.ts` + `validators.ts` | `MyraTMS/lib/tenants/` | Written |
| Integration test suite | `MyraTMS/tests/multitenant/isolation.test.ts` | Written, gated on `RUN_INTEGRATION_TESTS=1` |

## §2 — Pre-flight checklist

Before applying to staging:

- [ ] Patrice has reviewed the migration files (027, 028, 029)
- [ ] Patrice has reviewed `lib/db/tenant-context.ts` and the architectural shift to Pool/WebSocket (vs. existing HTTP `getDb()`)
- [ ] Patrice has authorized the staging branch creation OR provides a target staging connection string
- [ ] `MYRA_TENANT_CONFIG_KEY` env var is set on the staging environment (32-byte base64; generate with `openssl rand -base64 32`)
- [ ] No active Engine 2 production work would be disrupted (027/028/029 don't touch Engine 2 tables — verified via Rule A)

## §3 — Staging branch creation

Two options:

### Option A — Neon CLI / MCP (recommended for fast iteration)

The Neon MCP server is available in this environment. Patrice can authorize me to:

1. List available Neon projects: `mcp__Neon__list_projects`
2. Identify the prod project for MyraTMS
3. Create a staging branch from prod's current state: `mcp__Neon__create_branch` with name like `multitenant-test-2026-05-01`
4. Get the branch's connection string: `mcp__Neon__get_connection_string`

Cost: a Neon branch is instant (copy-on-write) and free under most plan tiers.

### Option B — Patrice provides a connection string manually

Patrice creates the branch via Neon dashboard and supplies the connection string out-of-band. Used if MCP authorization isn't desired.

Either way, the result is a `DATABASE_URL` pointing at the staging branch, which gets passed to the apply script below.

## §4 — Apply procedure

Once the staging branch is created and `DATABASE_URL` set:

```bash
# From MyraTMS/ directory:
cd MyraTMS

# 1. Apply migrations in order
psql "$DATABASE_URL" -f scripts/027_multi_tenant_foundation.sql
psql "$DATABASE_URL" -f scripts/028_add_tenant_id.sql
psql "$DATABASE_URL" -f scripts/029_create_rls_policies.sql

# 2. Run verification queries (manual SELECTs from each migration's footer)
#    See verification block at bottom of each migration file.

# 3. Set env vars for the test run
export RUN_INTEGRATION_TESTS=1
# DATABASE_URL already set
# MYRA_TENANT_CONFIG_KEY=$(openssl rand -base64 32)  # if not already set

# 4. Run the unit tests (no DB needed)
pnpm vitest run lib/crypto/__tests__/tenant-secrets.test.ts

# 5. Run the integration tests against staging
pnpm vitest run tests/multitenant/isolation.test.ts
```

Expected results:

- **027 apply**: 5 new tables (tenants, tenant_subscriptions, tenant_users, tenant_config, tenant_audit_log), 2 seed tenants (`_system`, `myra`), ~20 config rows for myra, 1 audit log entry
- **028 apply**: `tenant_id` column added to 26 Cat A tables, all existing rows backfilled to myra's id
- **029 apply**: 56 RLS policies created (28 tables × 2 policies each), RLS NOT enabled
- **Unit tests**: ~20 tests pass for crypto module
- **Integration tests**: 5 scenarios pass (RLS-enforcement scenarios skipped because RLS not enabled — that's Phase M3)

## §5 — Rollback procedure

If anything goes wrong:

```bash
# Reverse order — rollback 029 first, then 028, then 027
psql "$DATABASE_URL" -f scripts/029_create_rls_policies_rollback.sql
psql "$DATABASE_URL" -f scripts/028_add_tenant_id_rollback.sql
psql "$DATABASE_URL" -f scripts/027_multi_tenant_foundation_rollback.sql
```

Each rollback is idempotent and includes safety assertions:
- 027 rollback refuses to run if any TMS-core table still has `tenant_id` (must roll 028 first)
- 028 rollback refuses to run if any RLS policies exist (must roll 029 first)

If staging is unrecoverable, drop the Neon branch entirely:
```
mcp__Neon__delete_branch --branch multitenant-test-2026-05-01
```

## §6 — Production application (later, in Session 8)

This staging procedure is a **rehearsal** for Phase M3 production application. The production procedure adds:

- Backup PIT marker before applying
- Deploy-ID pinning (the Vercel deployment ID corresponding to this DB state)
- 24h soak between 027/028 + 029 (tenant_id + indexes go live first; policies sit dormant until M3 begins)
- Per-batch RLS enable per [RLS_ROLLOUT.md](./RLS_ROLLOUT.md)

Documented in detail in `PRODUCTION_MIGRATION.md` (Session 8 deliverable).

## §7 — Open items requiring Patrice authorization

| # | Item | Action requested |
|---|---|---|
| 1 | Neon staging branch creation via MCP | Authorize me to invoke `mcp__Neon__list_projects` and `mcp__Neon__create_branch`, OR provide a staging connection string out-of-band |
| 2 | `MYRA_TENANT_CONFIG_KEY` for staging | Generate (`openssl rand -base64 32`) and set on staging environment, OR allow me to generate one for the staging-only test run |
| 3 | Engine 2 v1 production status | Confirm whether Engine 2 v1 has begun production validation; this affects whether Phase M5 timing estimate (post-24h-soak) holds |
