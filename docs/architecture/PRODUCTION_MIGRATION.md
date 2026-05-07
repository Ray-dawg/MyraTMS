# PRODUCTION_MIGRATION.md

> **Purpose:** Operational runbook for applying multi-tenant migrations
> 027 → 031 to the production Neon branch and cutting the production
> deployment over to the multi-tenant code path.
>
> **Status:** Phase 8.2 deliverable. **Patrice authorization required**
> before any execution against production.
>
> **Audience:** The operator running the production deploy. May be the
> author after a soak window, may be a different operator picking the
> work back up — either way, this doc is the source of truth.
>
> **Related:**
> [ADR-004](./ADR-004-migration-strategy.md) (5-phase expand-contract),
> [STAGING_APPLY.md](./STAGING_APPLY.md) (staging procedure that this
> mirrors), [RLS_ROLLOUT.md](./RLS_ROLLOUT.md) (Phase M3 batch schedule),
> [PERFORMANCE_NOTES.md](./PERFORMANCE_NOTES.md) (load-test scenarios),
> [WAREHOUSE_INTEGRATION_POINTS.md](./WAREHOUSE_INTEGRATION_POINTS.md)
> (post-deploy warehouse integration).

## §1 — Current state at the start of this runbook

(Update this section before each execution.)

| Artifact | Production state |
|---|---|
| Migrations 027–029 | Applied to staging branch `br-twilight-wildflower-aidj2s93`. NOT applied to production branch `br-rough-forest-aif4a3vf`. |
| Migration 031 (tenant_usage) | Written, not yet applied to either branch. |
| Migration 030 (Engine 2 tenanting) | `.PENDING` placeholder; deferred per Engine 2 Rule A. |
| Application code | Multi-tenant withTenant + admin UI shipped on master branch (commits up through Session 7). NOT yet promoted to production Vercel deployment. |
| RLS enforcement | Policies CREATED in 029, NOT enabled anywhere. Phase M3 turns enforcement on per the RLS_ROLLOUT batch schedule. |

## §2 — The deployment-pinning protocol (CRITICAL)

Per ADR-004 §M1b — backup taken during M1b ↔ restore implications:

> If you PIT-restore to before M1b, the `tenant_id` column doesn't exist
> — application code that depends on it (M2-era) will fail. Mitigation:
> when running PIT restores during the migration period, also pin a
> corresponding Vercel deployment ID so DB and code roll back together.

**The protocol:**

1. Before every migration applied to production, **record both**:
   - The Neon branch's Postgres LSN at start (`SELECT pg_current_wal_lsn()`)
   - The current production Vercel deployment ID
2. After each migration, record the post-state LSN and the new deployment
   ID (if a deploy was promoted alongside).
3. Store these as a pair in `docs/architecture/PRODUCTION_MIGRATION_LOG.md`
   (create on first execution; append per migration).
4. **Rollback ALWAYS rolls both** — never PIT-restore the DB without
   simultaneously promoting back the matching Vercel deployment.

## §3 — Pre-flight checklist (run BEFORE any production change)

- [ ] **Patrice has authorized this specific production execution window.**
- [ ] Staging smoke is fresh: re-run staging integration tests
      (`RUN_INTEGRATION_TESTS=1 pnpm vitest run tests/multitenant/isolation.test.ts`)
      against the staging branch within the last 7 days.
- [ ] `npx tsc --noEmit` passes on the master branch HEAD.
- [ ] `pnpm vitest run` shows **0 regressions** vs. SESSION_7_SUMMARY's
      355/360 baseline (5 pre-existing Engine 2 failures only).
- [ ] PERFORMANCE_NOTES §7 index audit query returns a row for every
      Cat A table on staging.
- [ ] `MYRA_TENANT_CONFIG_KEY` is set on production Vercel env (NOT
      shared with staging — generate fresh via `openssl rand -base64 32`).
      Without this, encrypt/decrypt of `tenant_config` rows will fail.
- [ ] `CRON_SECRET` is set on production Vercel env (used by
      `forEachActiveTenant` cron handlers introduced in Session 3).
- [ ] No active production incident.
- [ ] Operator has read this runbook end-to-end at least once before
      starting (yes, including the rollback section).

## §4 — Migration sequence

Apply in this exact order. Each step has its own go/no-go gate.

### §4.1 — Apply 027 (foundation tables + seed Myra)

```bash
psql "$PROD_DATABASE_URL" -f MyraTMS/scripts/027_multi_tenant_foundation.sql
```

**Validates:**
- Creates `tenants`, `tenant_users`, `tenant_subscriptions`, `tenant_audit_log`,
  `tenant_config`
- Inserts `_system` tenant (id=1) and `myra` tenant (id=2)
- Seeds Myra's tenant_subscriptions row with `tier='internal'`
- Seeds the 19 default tenant_config rows for Myra

**Go criteria:**
- `SELECT COUNT(*) FROM tenants` returns 2
- `SELECT * FROM tenant_subscriptions WHERE tenant_id = 2` shows
  `tier='internal', status='active'`
- `SELECT COUNT(*) FROM tenant_config WHERE tenant_id = 2` returns ≥ 19

**No-go:** rollback via `027_multi_tenant_foundation_rollback.sql` and stop.

### §4.2 — Apply 028 (tenant_id column on Cat A tables)

```bash
# Set the migration default tenant_id (Myra = 2). 028 reads this via
# current_setting('myra_migration.tenant_id') for backfill.
psql "$PROD_DATABASE_URL" -c "SET myra_migration.tenant_id = '2'"
psql "$PROD_DATABASE_URL" -f MyraTMS/scripts/028_add_tenant_id.sql
```

**Validates (per Cat A table):**
- `tenant_id BIGINT NOT NULL DEFAULT 2` column exists
- Composite indexes `(tenant_id, ...)` are in place
- Existing rows have `tenant_id = 2` (the Myra default)
- Uniqueness constraints that scoped tenant-wise are now `(tenant_id, X)`
  composite

**Go criteria:**
- PERFORMANCE_NOTES §7 index audit returns a row for EVERY Cat A table
- Spot-check three tables: `loads`, `carriers`, `invoices` —
  `SELECT COUNT(*) FROM x WHERE tenant_id IS NULL` = 0
- Application's existing route handlers continue to work (run a
  read-only smoke against the production Vercel preview deploy)

**No-go:** rollback via `028_add_tenant_id_rollback.sql`. Note: the
rollback will fail if 029 has been applied — the order matters.

### §4.3 — Apply 029 (RLS policies, NOT yet enabled)

```bash
psql "$PROD_DATABASE_URL" -f MyraTMS/scripts/029_create_rls_policies.sql
```

**Validates:**
- 60 policies created across 30 tables (`tenant_isolation` +
  `service_admin_bypass` per Cat A table)
- `SELECT COUNT(*) FROM pg_policies WHERE schemaname = 'public'` ≥ 60
- **No table has `ROW LEVEL SECURITY ENABLED` yet** — this is intentional;
  Phase M3 enables in batches per RLS_ROLLOUT.md.

**Go criteria:**
- Policy count matches expected (60+)
- No application changes — RLS is policy-only, no enforcement runtime
  effect until ENABLE per table
- Production routes still work (sanity check on the same preview deploy)

**No-go:** rollback via `029_create_rls_policies_rollback.sql`.

### §4.4 — Apply 031 (tenant_usage table)

```bash
psql "$PROD_DATABASE_URL" -f MyraTMS/scripts/031_tenant_usage.sql
```

**Validates:**
- `tenant_usage(tenant_id, key, period, period_start, value)` exists
- Indexes on `(tenant_id, period, period_start DESC)` and
  `(key, period, period_start DESC)`
- RLS policies created (not enabled — Phase M3 same-batch as the rest)

**Go criteria:**
- `\d tenant_usage` shows the expected schema
- The Phase 4.4 daily aggregation cron (when built) can write to it

**No-go:** rollback via `031_tenant_usage_rollback.sql` (refuses if
rows present — must TRUNCATE first if usage data accumulated).

### §4.5 — Promote application code to production

The master-branch HEAD has Sessions 1–7 deliverables. Promote ONLY
after all DB migrations above succeed.

```bash
# Vercel CLI (from a CI environment with VERCEL_TOKEN)
vercel deploy --prod --token=$VERCEL_TOKEN
```

**Capture immediately after promotion:**
- Vercel deployment ID (record in PRODUCTION_MIGRATION_LOG.md)
- Neon LSN post-deploy (`SELECT pg_current_wal_lsn()`)

**Smoke checklist post-deploy:**
- [ ] Login as a real Myra admin user; dashboard renders
- [ ] `/api/me/tenant` returns 200 with `tier='internal', features=ALL`
- [ ] `/admin/tenants` shows the Myra tenant + its user count + load count
      (super-admin only — operator must have `is_super_admin=true`)
- [ ] One pre-existing route still works (`/loads`, `/finance/summary`,
      `/api/notifications`)
- [ ] `tenant_audit_log` has new entries for the smoke test (login is
      not audited; admin-page visits + service-admin actions are)

## §5 — Rollback procedure

Per the deployment-pinning protocol (§2), rollback always pairs the
DB and the deployment.

### §5.1 — If a migration fails partway

Run its rollback script (each migration has a paired
`*_rollback.sql`). Then promote the previous Vercel deployment:

```bash
# Promote previous deployment as production
vercel rollback <previous-deployment-id> --token=$VERCEL_TOKEN
```

### §5.2 — If a migration succeeded but post-deploy smoke fails

Two options, pick by severity:

**Forward-fix** (preferred for non-critical issues): patch the
problem on master, deploy a new revision. This is the right call for
UI bugs, route 500s on edge cases, missing notifications, etc.

**Backward rollback** (only for data integrity / security incidents):
- PIT-restore the DB to the LSN captured before the most-recent
  migration: `neonctl branches restore <branch> <timestamp>`
- Promote the matching Vercel deployment via `vercel rollback`
- Append a `_rollback_executed` entry to PRODUCTION_MIGRATION_LOG.md
  with the reason

### §5.3 — Never do these

- **Never** PIT-restore without rolling deployment too — code that
  expected `tenant_id` will throw at runtime
- **Never** roll the deployment back without considering DB state —
  legacy code paths against post-migration tables can produce wrong
  results (writes that ignore `tenant_id` would default to 2 via the
  column DEFAULT, conflating real tenant data with the legacy default)
- **Never** skip the LSN/deployment-id pairing capture — without it,
  a future incident has no clean rollback target

## §6 — Cutover communication plan

The first real customer visible to this rollout is Tenant 1 (Myra
itself, internal). Sudbury (Tenant 2 in the future, separate provisioning)
is a customer-facing event that should have its own announcement.

**Internal cutover (Myra users):**
- After §4.5 promotion succeeds, post in #engineering: "Multi-tenant
  rollout phase M2 complete. Internal users may notice: a new 'Tenants'
  super-admin item in the sidebar (visible to super-admins only), a new
  /admin/settings page, and tier-aware UI gating for Load Board /
  Intelligence / Reports / Workflows. No data migrations to the user-
  visible loads/carriers/invoices — those tables now carry `tenant_id`
  columns but it's the same data."
- Flag that RLS enforcement is NOT YET active — that's Phase M3, batch
  per RLS_ROLLOUT.md, ~28 days.

**External cutover (when Sudbury or other paying tenant onboards):**
- Use the `/admin/tenants` create + onboard flow (Phase 5 UI from
  Session 6)
- Send the new owner a tenant-scoped invite via the admin UI's invite-user
  flow
- The owner accepts, lands in the dashboard scoped to their tenant by
  the JWT
- Audit log entries for `tenant_created`, `tenant_onboarded`,
  `tenant_user_invited` should be visible to the platform owner

## §7 — Post-deploy follow-ups (operational, not coding)

Per the open items across SESSION_4..7_SUMMARY:

| Follow-up | Window | Owner |
|---|---|---|
| Phase M3 RLS enable per RLS_ROLLOUT batch schedule | Days 1–28 post-§4.5 | Operator |
| Daily Redis→tenant_usage aggregation cron | Within 14 days of §4.5 | Future session |
| Tenant 2 (Sudbury) provisioning + 7-day soak | Per business timeline | Operator + Sudbury team |
| Phase M4 contract (drop tenant_id DEFAULT, reject JWTs without claim) | Post 7-day soak | Operator |
| Phase M5 Engine 2 tenanting (migration 030) | Post Engine 2 v1 + 24h | Future session |

## §8 — Open items (decisions still needed)

| # | Item | Status |
|---|---|---|
| 1 | Production execution window — when to apply 027–031 | NOT scheduled. Patrice authorization required. |
| 2 | Whether to apply 027–031 in one window or split across two windows | Recommend single window: 027 + 028 + 029 + 031 are all idempotent CREATE/ALTER; the risk window is short (~minutes); rollback is per-migration and well-tested. |
| 3 | Whether to use Vercel preview deploy as the post-migration smoke target before promoting to production | Recommend YES — promote master to a preview, point preview at the migrated production DB (or staging post-031), run the smoke from §4.5, then promote to production after green. |
| 4 | Phase M3 acceleration cadence | Default per RLS_ROLLOUT: 1 batch/day. Acceleration to 2/day after 3 clean days. Patrice arbitrates. |

End of runbook. Update PRODUCTION_MIGRATION_LOG.md (creates on first
execution) with each step's LSN + deployment-id pair as you go.
