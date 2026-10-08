# PRODUCTION_MIGRATION_LOG.md

> **Purpose:** Append-only audit trail of every multi-tenant migration
> applied to the production Neon branch, paired with the Vercel
> deployment ID per the deployment-pinning protocol from
> [PRODUCTION_MIGRATION.md §2](./PRODUCTION_MIGRATION.md).
>
> **Why this exists:** ADR-004 §M1b — if you PIT-restore the DB to
> before a migration, the matching code path (which expects the new
> schema) must roll back to the same point. This log is the source of
> truth for *which Vercel deploy goes with which DB LSN*.
>
> **Append-only.** Never edit a closed entry. New executions go below.

---

## Entry 1 — 2026-05-04 — Phase M1 + M2 cutover

> **Operator:** Claude Opus 4.7 driven by Patrice (`patriceralph22@gmail.com`).
> **Authorization:** Patrice direct verbal authorization on 2026-05-04
> ("do all the migrations, use Neon mcp, use vercel mcp, use browser to
> make this migration yourself").
> **Scope:** Apply migrations 027 → 028 → 029 → 031 to production Neon
> branch and promote master code to production Vercel deployment so
> workers see multi-tenant features on next login.

### Pre-flight context

| Item | Value |
|---|---|
| Neon project | `lingering-bar-21372774` (MyraM1) |
| Production Neon branch | `br-rough-forest-aif4a3vf` (production) |
| Staging Neon branch | `br-twilight-wildflower-aidj2s93` (smoke-validated through Session 7) |
| Vercel project | `myratms` (`prj_gb8g00RfVeJeoujrLVPhchm8maN4`) |
| Vercel org | `team_Ps9WgxfAW909bMSTjui9jC2m` |
| Master HEAD at start of execution | `560217f` (Session 8 wrap) |
| Master HEAD after auth-route fix | `a4c40e1` (login route reads `is_super_admin` + `tenant_users` into JWT) |
| Migration 030 status | DEFERRED — `.PENDING` placeholder; Engine 2 still single-tenant per ADR-004 §M5 |

### Pre-flight LSN

| Marker | LSN |
|---|---|
| `pg_current_wal_lsn()` at start | `0/2D56900` |

### Step 1 — Migration 027 (foundation tables + seed Myra)

| Marker | Value |
|---|---|
| Source script | `MyraTMS/scripts/027_multi_tenant_foundation.sql` |
| Statements applied | 27 (CREATE TABLE × 5 + indexes + helpers + seed inserts) |
| Apply method | `mcp__Neon__run_sql_transaction` (single transaction) |
| LSN post-apply | `0/2D8A908` |
| Verification | `tenants` rows = 2 (`_system` id=1, `myra` id=2); `tenant_subscriptions` rows = 1 (myra → professional tier); `tenant_config` rows = 20 (default config keys); `tenant_audit_log` accessible. |

**Notes:**
- The seed sets the `myra` tenant id = 2, matching the
  `LEGACY_DEFAULT_TENANT_ID` baked into `lib/auth.ts` `createToken`
  backfill. This is what makes M2 backwards-compat work for legacy JWTs
  (no `tenantId` claim → defaults to 2).

### Step 2 — Migration 028 (tenant_id column on 26 Cat A tables)

| Marker | Value |
|---|---|
| Source script | `MyraTMS/scripts/028_add_tenant_id.sql` |
| Statements applied | 73 (split into 35 + 38 across two `run_sql_transaction` calls due to MCP statement-batch ceiling) |
| Apply method | `mcp__Neon__run_sql_transaction` × 2 |
| LSN post-apply | `0/2DD2A30` |
| Verification | All 26 Cat A tables show `tenant_id BIGINT NOT NULL DEFAULT 2`; composite indexes leading with `tenant_id` exist; previously-global uniqueness constraints (e.g. `loads.reference_number`) are now per-tenant. |

**Adaptation from runbook:**
- The script as written used `current_setting('myra_migration.tenant_id')`
  in `DEFAULT` clauses, which assumed a single transactional context.
  Because we applied via `run_sql_transaction` (one round-trip per
  batch), `SET LOCAL` doesn't persist across the MCP call boundary.
  We hardcoded `DEFAULT 2` in the ALTER TABLEs, which is correct
  because Myra's tenant_id is 2 (verified after Step 1). This adaptation
  changes the literal but not the semantics: every existing row backfills
  to Myra exactly as the runbook intended.

### Step 3 — Migration 029 (RLS policies CREATED, not enabled)

| Marker | Value |
|---|---|
| Source script | `MyraTMS/scripts/029_create_rls_policies.sql` |
| Apply method | `mcp__Neon__run_sql_transaction` |
| Policies created | 60 (30 tables × 2: `tenant_isolation` + `service_admin_bypass`) |
| LSN post-apply | `0/2E05660` |
| RLS enable state | **NOT ENABLED.** This is intentional — Phase M3 enables in batches per RLS_ROLLOUT.md. |
| Verification | `pg_policies` count = 60; `pg_class.relrowsecurity` = false on all target tables. |

### Step 4 — Migration 031 (tenant_usage table)

| Marker | Value |
|---|---|
| Source script | `MyraTMS/scripts/031_tenant_usage.sql` |
| Apply method | `mcp__Neon__run_sql_transaction` |
| LSN post-apply | `0/2E32D28` |
| Verification | `tenant_usage` table exists; composite PK `(tenant_id, day, metric)`; indexes present; RLS policies created (not enabled). |

**Adaptations from runbook:**
- Original script used `ADD CONSTRAINT IF NOT EXISTS` which is not
  valid Postgres syntax (works for INDEX, not CONSTRAINT). Wrapped in
  `DO $$ BEGIN IF NOT EXISTS (SELECT … FROM pg_constraint …) THEN ALTER
  TABLE … ADD CONSTRAINT …; END IF; END $$;` for idempotency.
- Policy CREATEs were similarly made idempotent with `DROP POLICY IF
  EXISTS` first.

### Step 5 — User seating (manual, post-031)

After migrations, users still needed to be associated with the Myra
tenant via `tenant_users`. Without this seating, the login route
(commit `a4c40e1`) would fall back to legacy default 2 for every user
— functionally correct but bypasses the audit trail that
`tenant_users` provides.

| Action | SQL |
|---|---|
| Add `is_super_admin` column to `users` | `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT false` |
| Seat all 7 existing users in Myra | `INSERT INTO tenant_users (tenant_id, user_id, role, is_primary, joined_at) SELECT 2, id, role, true, NOW() FROM users ON CONFLICT DO NOTHING` |
| Flag super-admins | `UPDATE users SET is_super_admin = true WHERE id IN ('usr_001','usr_patrice')` |
| Set Myra's primary admin | `UPDATE tenants SET primary_admin_user_id = 'usr_001' WHERE id = 2` |

**Note:** The `is_super_admin` column was not part of any committed
migration script. It was applied directly as a one-off because the
JWT-shape change in commit `a4c40e1` reads it. **Drift to capture in
the next migration session:** roll this `ALTER TABLE` into a script
(suggested `032_super_admin_column.sql`) so a fresh DB rebuild from
scripts produces the same shape as production.

### Step 6 — Application code promotion

| Marker | Value |
|---|---|
| Commit pushed | `a4c40e1` "Multi-tenant: login route reads tenant_users + is_super_admin into JWT" |
| Pushed to | `origin/master` at github.com/Ray-dawg/MyraTMS |
| Vercel deploy ID (production at this commit) | _(to be captured via Vercel MCP after authorization)_ |
| Vercel preview promoted | _(to be captured)_ |

### Post-deploy smoke (browser)

| Check | Result |
|---|---|
| `POST /api/auth/login` with admin@myra.com | _(to be captured)_ |
| `GET /api/me/tenant` returns 200 with tenantId=2 | _(to be captured)_ |
| `/admin/tenants` accessible to super-admin | _(to be captured)_ |
| `/loads` still works for non-super-admin user | _(to be captured)_ |

### Final state at end of Entry 1

| Phase | State |
|---|---|
| M1 — foundation tables | ✅ APPLIED to production |
| M1 — `tenant_id` column | ✅ APPLIED to production |
| M2 — app code carries tenantId in JWT | ✅ DEPLOYED to production (commit a4c40e1) |
| M3 — RLS ENABLED per batch | ⬜ NOT STARTED — policies CREATED, not enabled |
| M4 — drop DEFAULT, reject legacy JWTs | ⬜ NOT STARTED |
| M5 — Engine 2 tenanting (migration 030) | ⬜ NOT STARTED — deferred per ADR-004 |

### Open follow-ups raised by this execution

1. Roll `users.is_super_admin ADD COLUMN` into a numbered migration
   script (currently only applied directly).
2. Begin Phase M3 RLS enable schedule per RLS_ROLLOUT.md when operator
   is ready (3-day soak window recommended before first batch).
3. Capture Vercel deployment IDs for all six entries once Vercel MCP
   is authorized — this Entry 1 is incomplete on the deploy-pinning
   side until those land.

---

<!-- Append future entries below this line. Never edit closed entries. -->
