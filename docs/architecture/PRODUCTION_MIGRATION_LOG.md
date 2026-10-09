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

## Entry 2 — 2026-10-08 — Phase M3 unblock + RLS Day 1

Branch: `br-rough-forest-aif4a3vf` (production). Executed against the two
blockers recorded in RLS_ROLLOUT.md §0 on 2026-10-07, then Day 1 of the §1
schedule. Operator approval, verbatim: "I Approve creating myra_app and
rotating DATABASE_URL (then 061, then 060, then Day 1)." and "I Approve
cleaning the leftover test rows in production."

Order was fixed by that approval and followed exactly. Every step was first
rehearsed on the `dev-tests` branch (`br-damp-river-ai21gg86`).

### Pre-flight LSN / PIT marker

Taken immediately before the `ENABLE ROW LEVEL SECURITY` statement:

| Field | Value |
|---|---|
| `now() AT TIME ZONE 'UTC'` | `2026-10-08T22:07:25.877Z` |
| `pg_current_wal_lsn()` | `0/BB35538` |
| `current_database()` | `neondb` |

### Step 1 — Create role `myra_app`

```sql
CREATE ROLE myra_app LOGIN PASSWORD '<redacted>'
  NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
```

Run as `neondb_owner`. Verified from a fresh connection as the new role:
`current_user = myra_app`, `rolbypassrls = false`, `rolsuper = false`,
`fn_myra_tenant_id() = 2`, and DDL denied
(`permission denied for schema public`).

The password exists only in the gitignored
`MyraTMS/.env.myra_app.production.local` (confirmed with `git check-ignore`)
and in the Vercel production env. It is not in git and was never printed
unmasked.

### Step 2 — Migration 061 (`scripts/061_app_role_grants.sql`)

Applied as `neondb_owner`. Post-apply grant probe as `myra_app`:

- `SELECT 1` succeeded on all 20 core tables probed (loads, shippers,
  carriers, users, tenant_users, tenants, documents, invoices, drivers,
  notifications, activity_notes, tenant_subscriptions, tenant_config,
  settings, workflows, quotes, pipeline_loads, events, exceptions,
  tracking_tokens).
- Zero `public` tables/views lack SELECT for `myra_app`.
- `has_table_privilege('loads','INSERT') = true`.

### Step 3 — Rotate Vercel production `DATABASE_URL`

Rotated to the `myra_app` connection string and redeployed; the deployment
built and aliased to `myratms.vercel.app`. Confirmed by `vercel env pull`.

Two execution notes worth keeping:

1. `vercel env add` wrote an **empty value** twice when the value was piped to
   stdin (once from PowerShell, once from Bash `printf`). The working form was
   `vercel env add DATABASE_URL production --value "$URL" --no-sensitive`.
2. The **pre**-rotation value contained a trailing newline — the same defect
   class CLAUDE.md warns about for kill switches. The new value does not.

`.vercel/project.json` could not be read from inside the repo (OneDrive
placeholder: "The cloud file provider is not running"). Worked around by
linking a temp dir with
`vercel link --yes --project myratms --scope patrices-projects-85c0644c`.

### Step 4 — Migration 060 (`scripts/060_harden_rls_policies.sql`)

Applied as `neondb_owner`. Verified `unhardened: 0` of `total_policies: 30`;
`rls_enabled_tables: 0` at that point. Policies on `tenant_audit_log` after
060:

```
[ALL] service_admin_bypass  USING/CHECK: current_setting('app.role', true) = 'service_admin'
[ALL] tenant_isolation      USING/CHECK: tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::bigint
```

### Step 5 — Leftover test-row cleanup (approved separately)

The pre-guard test suite had written rows into production. Deleted in one
transaction, as `neondb_owner`:

| Table | Rows | How |
|---|---|---|
| `exceptions` | 16 | explicit delete (FK is restrict-by-default) |
| `pipeline_loads` | 6 | the `TEST-CASCADE-DISPATCH-*`, `TEST-DISP-*`, `TEST-IDEMP-*`, `TEST-PROSPECT-*` rows (ids 695, 696, 697, 1243, 1244, 1245) |
| `events` | 18 | cascaded automatically (`ON DELETE CASCADE`) |
| `payer_registry` | 1 | id 33, `ACME CO` |

Audited as `tenant_audit_log` id 345, `event_type = 'test_row_cleanup'`,
with the approval, the reason, and the per-table counts in the payload.
Post-check: 0 matching `pipeline_loads`, 0 `payer_registry` id 33.

**Root cause of the earlier FK failure, worth recording** — this is the bug
CLAUDE.md attributes to `scripts/sprint6-shadow/06-cleanup.ts`:
`exceptions.pipeline_load_id` is `integer` and references
`pipeline_loads(id)`, the integer surrogate PK — **not** `pipeline_loads.load_id`,
which is the TEXT business key. A dependency census keyed on the `TEST-…`
load_id strings therefore returns 0 for every FK table, and the delete then
fails on `exceptions_pipeline_load_id_fkey`. Census by PK found the 16 real
dependents. 15 tables carry a `pipeline_load_id` FK plus
`inbound_emails.matched_load_id`; seven are `ON DELETE CASCADE` and eight are
restrict-by-default.

### Step 6 — RLS Day 1: `tenant_audit_log`

```sql
BEGIN;
ALTER TABLE tenant_audit_log ENABLE ROW LEVEL SECURITY;
SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'tenant_audit_log';
-- relrowsecurity = true, verified in-transaction
COMMIT;
```

Smoke test as `myra_app` (all probes in rolled-back transactions):

| Probe | Result |
|---|---|
| no context | 0 rows — fail closed ✅ |
| Myra tenant context | 9 rows ✅ |
| wrong tenant (999999) | 0 rows ✅ |
| `app.role = 'service_admin'` | 344 rows ✅ |
| `service_admin` INSERT | allowed ✅ |
| per-tenant INSERT, own tenant | allowed ✅ |
| cross-tenant INSERT | **DENIED** ✅ |

`GET /api/health` → 200, `db.ok = true` (69 ms), `redis.ok = true`.

### Final state at end of Entry 2

| Phase | State |
|---|---|
| M1 / M2 | ✅ unchanged from Entry 1 |
| Migration 060 | ✅ APPLIED to production |
| Migration 061 | ✅ APPLIED to production |
| App DB role | ✅ Vercel on `myra_app` (NOBYPASSRLS) · ⬜ **Railway still on `neondb_owner`** |
| M3 — RLS ENABLED per batch | 🟡 **Day 1 of 12 done** (`tenant_audit_log`); Days 2+ pending |
| M4 / M5 | ⬜ NOT STARTED |

### Open follow-ups raised by this execution

1. **Rotate `DATABASE_URL` on Railway (`myratms-workers`) to `myra_app`.** Until
   then every worker path keeps BYPASSRLS and RLS is a no-op for it. The
   Railway CLI was unauthenticated in the executing session
   (`railway whoami` → "Unauthorized"), so this is the operator's to do.
2. The §3 four-hour monitor for Day 1 was not run to completion in-session.
3. `TEST_RLS_ENABLED=1` in the isolation suite is table-agnostic and cannot
   gate a partial rollout — see RLS_ROLLOUT.md §0a.
4. Migrations continue to run as `neondb_owner` by design; only the app
   connection moved to `myra_app`.

---

## Entry 3 — 2026-10-09 — GATE 0: tenant-header bypass closed, middleware enabled

No database migration. Code-only deploy, recorded here because it changes the
production authorization boundary and because it is the first time
`middleware.ts` has ever executed in production.

### What was deployed

`origin/master` `2eed7ee` → **`b334446`** (15 commits; Vercel project `myratms`
builds from the GitHub remote). The two that matter here:

| Commit | Layer |
|---|---|
| `a5055f0` | `getTenantContext()` resolves tenant from the signed JWT, never from `x-myra-*` request headers |
| `b334446` | `config.matcher` fixed so middleware routes at all, plus the bypass lists that make that survivable; `/api/documents` driver row-scoping; `/api/health` error redaction |

The other 13 are the E2-01 shipper-direct gate stack and the FMCSA QCMobile
lookup fix, which rode along. All E2-01 behaviour stays behind
`SHIPPER_DIRECT_GATE_ENABLED`, which was not touched.

GATE 0 assigned the second layer to Gate 4. It was released here at the
operator's explicit direction, after the build-artifact and live verification
below.

### Verified live, after deploy

The exploit was confirmed **still live at 14:44 UTC**, minutes before the deploy
landed: `GET /api/loads` with `x-myra-tenant-id: 2`, no cookie and no token,
returned HTTP 200 and real load rows. It flipped to 401 at 14:45:17 UTC.

Bypass-list verification against production (the actual risk of enabling
middleware — a wrong entry 401s a cron, the Retell webhook, or a shipper
confirmation link). Note the discriminator: middleware's own rejection body is
`{"error":"Unauthorized"}` capitalised, so a **405** or a **lowercase**
`unauthorized` proves the request reached the route instead:

| Request | Result | Reading |
|---|---|---|
| `GET /api/loads` + forged `x-myra-tenant-id: 2` | 401 | **exploit dead** |
| `GET /api/health` | 200, `db.ok:true` | bypass OK; also confirms Vercel's `myra_app` role reads fine |
| `GET /api/webhooks/retell-callback` | 200 | bypass OK — webhook POSTs will land |
| `POST /api/cron/pipeline-scan` | **405** | bypass OK (405 is Next's router, after middleware) |
| `GET /api/cron/pipeline-scan` | 401 **lowercase** | bypass OK — the route's own `CRON_SECRET` check answered |
| `POST /api/pipeline/import` | 401 **lowercase** | bypass OK — route's own token check answered |
| `GET /api/confirmations/<junk>` | 404 `Confirmation not found` | handler reached — E2-04 confirm flow intact |
| `GET /api/tracking/<junk>` | 404 `Tracking token not found` | handler reached |
| `POST /api/auth/login` | 400 `Email and password are required` | public — nobody is locked out |
| `POST /api/auth/driver-login` | 400 | public — DApp login intact |
| `GET /rate/<junk>` | 200 | public rating page intact |
| `GET /api/shippers`, `/api/carriers`, `/api/invoices` | 401 | protected (these are the three a driver JWT used to reach) |
| `GET /api/tracking/positions` | 401 | protected — the old bare `/api/tracking/` prefix had bypassed this |
| `GET /api/documents` | 401 | protected |
| `GET /dashboard`, no cookie and with `auth-token=garbage` | 307 both | page routes redirect, no 401 dead-end |

Pre-deploy: `pnpm build` succeeded and emitted `Proxy (Middleware)`; the
compiled matcher was read back out of `.next/server/middleware-manifest.json`
and confirmed to match `/api/*` and page routes while skipping
`/_next/static/*`, `/favicon.ico` and `/manifest.json`. 175 new tests pass;
full suite 1071 passed / 3 failed / 5 skipped, the 3 failures pre-existing on
`4d552eb` in the E2-03 carrier-verification path.

### Found while validating the bypass lists — NOT fixed

1. **`/api/cron/fmcsa-reverify`, `/api/cron/invoice-alerts` and
   `/api/cron/shipper-reports` have never executed.** Each exports `POST` only
   and reads `x-cron-secret`; a Vercel cron invocation is `GET` +
   `Authorization: Bearer $CRON_SECRET`, so Next answers 405 from the router
   before any handler code. Two independent mismatches, either one fatal.
   **Treat their effects as never having happened** — no FMCSA re-verification,
   no invoice reminders, no monthly shipper reports have ever been sent.
   Deliberately left off: switching them on starts live FMCSA API traffic and
   real outbound email to external shippers, retroactive over everything that
   has aged since. Operator decision. The five that work (`exception-bridge`,
   `exception-detect`, `feedback-aggregation`, `pipeline-health`,
   `pipeline-scan`) export `GET` and read `authorization`; match that shape.
2. **`/api/documents` had no row scoping for driver principals.** Fixed in
   `b334446` — it had to be the same commit, because middleware is what grants
   a driver token that path.

### Open follow-ups — all operator-only, GATE 0 is NOT closed

Entry 2 follow-up 1 (rotate Railway `DATABASE_URL` to `myra_app`) is still
open and is now also a GATE 0 exit criterion. Added by this entry:

1. **Confirm `MAX_CONCURRENT_CALLS=0`** on Vercel `myratms` **and** Railway
   `myratms-workers`. Found at `25` on 2026-08-26 and never re-verified. Check
   for trailing whitespace — kill switches are exact-match
   `.trim().toLowerCase()`.
2. **Set `FMCSA_QC_WEBKEY` on Railway and Vercel.** Value is in git-ignored
   `MyraTMS/.env.local`. Without it the E2-01 gate fails closed and every
   poster-registry miss routes to human review.
3. **Watch for 401s on the Vercel cron runs, the Retell webhook and shipper
   confirmation links** over the next day. Middleware is newly live; those are
   the three failure modes a wrong bypass entry produces.

---

<!-- Append future entries below this line. Never edit closed entries. -->

---

## Entry 4 — 2026-10-09 — GATE 1: `poster_registry` seeded on production + historical back-fill

No schema migration. A **data** change, recorded here because it writes 2,253
rows to a production table that gates an accept/reject decision, and because it
mutates 250 existing `pipeline_loads` rows.

### What was written

| Target | Before | After |
|---|---|---|
| `poster_registry` | 0 rows | **2,253 rows** |
| `pipeline_loads.load_source_*` | NULL on all 250 | `unresolved`/review on all 250 |
| `pipeline_loads.poster_company_normalized` | NULL on all 250 | populated on all 250 |

Branch `br-rough-forest-aif4a3vf`, endpoint `ep-lively-shadow-aibzw8bp`, via an
explicit `--env-file` holding only `DATABASE_URL`. `.env.local` was not edited.
Both scripts ran from the worktree `.worktrees/gate1-registry-calibration`
at commit `85b74b5`.

```
pnpm tsx --env-file=<prod> scripts/e2_seed_poster_registry.ts --dry-run   # 2253
pnpm tsx --env-file=<prod> scripts/e2_seed_poster_registry.ts             # 2253 inserted / 0 skipped
pnpm tsx --env-file=<prod> scripts/e2_backfill_load_source.ts             # processed=250 accept=0 reject=0 review=250
pnpm tsx --env-file=<prod> scripts/e2_source_calibration_report.ts        # exit 0
```

### Registry composition, verified by direct query after the run

| entity_class | class_source | confidence | rows |
|---|---|---|---|
| broker | `seed_broker_list_fmcsa` | 0.95 | 1524 |
| broker | `seed_broker_list` | 0.90 | 52 |
| carrier_for_hire | `seed_carrier_list` | 0.90 | 381 |
| shipper | `seed_shipper_list` | 0.90 | 248 |
| shipper | `seed_mines_dossier` | 0.95 | 48 |

Zero duplicate `normalized_name` values. 1,263 rows carry both MC and DOT.
**296 rows are accept-capable** (`entity_class IN ('shipper','carrier_private')
AND confidence >= 0.8`) — `poster_registry` is the only path to a
`shipper_direct` accept, because FMCSA cannot establish shipper-direct status
(every private fleet also registers "Authorized For Hire", verified live
2026-10-08).

### Behavioural blast radius: none, today

All E2-01 classification is behind `SHIPPER_DIRECT_GATE_ENABLED`, which was
**not** touched and remains unset. Seeding the registry changes no request
path. The back-fill writes only `load_source_*`, `poster_registry_id` and the
two poster-identity columns — never `stage` or `qualification_reason`.

### Rollback

`DELETE FROM poster_registry WHERE class_source IN ('seed_broker_list',
'seed_broker_list_fmcsa', 'seed_carrier_list', 'seed_shipper_list',
'seed_mines_dossier');` restores the pre-state exactly — every row written here
carries one of those five `class_source` values and the table was empty before.
The back-fill is idempotent and re-runnable with `--force`; to revert it,
`UPDATE pipeline_loads SET load_source_class = NULL, load_source_method = NULL,
load_source_confidence = NULL, load_source_evaluated_at = NULL,
load_source_evidence = NULL, poster_registry_id = NULL;` (the poster-identity
columns are worth keeping — they are derived from `shipper_company`, which is
unchanged).

### What this does NOT close

PRD §4.13 **criterion 4 stays OPEN.** All 250 production `pipeline_loads` are
synthetic `TEST_*` fixtures from the 2026-06/08 shadow drain, every one
`created_by='scanner-csv-v1'` with `shipper_direct_attestation` NULL, so
`classifyLoadSource()`'s manual-import branch is authoritative and the registry
is never consulted — `registryHitRate` is 0 over a 2,253-row registry. That is
a missing-ingest problem, not a data-volume one: `loadboard_sources.dat.
last_polled_at` is NULL (the scraper has never polled, roadmap A.3.3 open) and
every other source is `disabled`. Criterion 5 is PASS on production.
