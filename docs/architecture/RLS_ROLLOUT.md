# RLS_ROLLOUT.md

> **Cadence:** Updated daily during Phase M3 rollout.
> **Last update:** 2026-10-08 — **Both §0 blockers CLEARED on production; Day 1 (`tenant_audit_log`) ENABLED and verified.** See §0 "Blocker clearance" and the Day 1 row in §1. Earlier same day: **Phase M3 still NOT STARTED.** Prerequisites (027–031) have been in production since 2026-05-04; `loads` rowsecurity verified OFF by direct query 2026-10-07. The schedule below is unchanged and unexecuted. Engine 2 tables remain deferred to M5 (migration 030 still `.PENDING`).
> **Related:** [ADR-001](./ADR-001-tenant-isolation.md), [ADR-004](./ADR-004-migration-strategy.md), [SECURITY.md](./SECURITY.md)

This document is the live schedule and status log for Phase M3 — per-table Row-Level Security enablement. Default cadence: 1 table/day starting from lowest-traffic and progressing to hot-path tables. Patrice arbitrates acceleration.

## §0 — Pre-flight findings (2026-10-07, dev-tests branch `br-damp-river-ai21gg86`)

Pre-flight for batch 1 (`tenant_audit_log`, `tenant_users`, `tenant_subscriptions`) was run against a fresh branch of production. Index audit and leak audit are green; **two blockers mean the schedule in §1 must not start until they are cleared.**

| Check | Result |
|---|---|
| Index audit (PERFORMANCE_NOTES §7) | ✅ All 30 policied tables have a `tenant_id`-leading index (direct query on production, read-only). |
| Cross-tenant leak audit (`tests/multitenant/isolation.test.ts`) | ✅ 15/15 pass, 3 RLS-gated scenarios skipped (RLS off). **The suite had never run before** — `vitest.config.ts` only included `**/__tests__/**`, so `tests/multitenant/` was silently excluded. Fixed; three stale test bugs fixed (BIGINT-as-string tenant ids, a query against a non-existent `tenants.tenant_id`, a fixed tracking token that leaked across runs). |
| Route audit for batch-1 tables | ✅ Every reader/writer of the three tables goes through `asServiceAdmin()`/`withTenant()` **except** `POST /api/auth/login`, which read `tenant_users` via plain `getDb()` (no context). Under RLS that returns zero rows and every login silently falls back to `LEGACY_DEFAULT_TENANT_ID = 2`. **Fixed** — now `asServiceAdmin("login: resolve tenant membership …")`. |
| Policy behaviour under a reused pooled connection | ✅ **Blocker 1 — CLEARED 2026-10-08** (was ❌). `current_setting('app.current_tenant_id', true)` returns `''` (not NULL) on any connection that previously ran `SET LOCAL` on it. 029's `::BIGINT` cast then errors (`invalid input syntax for type bigint: ""`) for every context-less query — including `asServiceAdmin()` reads — instead of returning zero rows. Reproduced on dev-tests. **Fix: migration `060_harden_rls_policies.sql`** (NULLIF guard; applied + verified on dev-tests: no-context → 0 rows, Myra context → correct rows, service_admin → all rows). Must be applied to production *before* the first ENABLE. |
| Application role vs RLS | ✅ **Blocker 2 — CLEARED 2026-10-08** (was ❌). `neondb_owner` — the role in every `DATABASE_URL` (Vercel, Railway, local) — has `rolbypassrls = true` and owns every table. With RLS **enabled** on `tenant_audit_log` and a deliberately wrong tenant context, it still saw all 338 rows. A plain non-bypass role saw 7 / 0 / 338 (Myra / wrong tenant / service_admin), so the policies themselves are correct. **The entire §1 schedule is a no-op for the deployed app until the app connects as a non-BYPASSRLS, non-owner role.** `FORCE ROW LEVEL SECURITY` does not help (BYPASSRLS skips it). SECURITY.md's "connection user is NOT a superuser" is true but insufficient. **Proposed fix: create `myra_app` (Neon console/MCP, no BYPASSRLS) + migration `061_app_role_grants.sql` (drafted, not applied) + rotate `DATABASE_URL` on Vercel and Railway.** Migrations keep using `neondb_owner`. This is a production credential change and needs Patrice's go-ahead. |
| `resolveTrackingToken()` return type | ⚠️ Returned `tenantId` as a string (BIGINT quirk); `tracking/[token]/events` passed it straight into `withTenant()`, which rejects non-integers. Fixed at the source (`Number()`), caught by the leak suite's Scenario 5. |

**Revised batch-1 pre-conditions (replaces "Pre-flight gates" for Days 1–3):**
1. Apply `060_harden_rls_policies.sql` to production (separate, confirmed step; log in PRODUCTION_MIGRATION_LOG.md).
2. Create `myra_app`, apply `061_app_role_grants.sql`, rotate `DATABASE_URL` on Vercel + Railway, confirm `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user` is `false` from the app.
3. Deploy the login-route fix (commit on `master`).
4. Re-run `RUN_INTEGRATION_TESTS=1 TEST_RLS_ENABLED=1` isolation suite on dev-tests **as `myra_app`** with batch-1 tables enabled there.
5. Only then: Day 1 `tenant_audit_log` on production per §3.

## §0a — Blocker clearance + Day 1 (2026-10-08, production `br-rough-forest-aif4a3vf`)

Both §0 blockers are cleared on production, in the order Patrice approved
("create `myra_app` and rotate `DATABASE_URL`, then 061, then 060, then Day 1").
Every step was rehearsed on `dev-tests` first.

| # | Step | Result |
|---|---|---|
| 1 | `CREATE ROLE myra_app LOGIN ... NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT` | ✅ Verified from the app connection: `current_user = myra_app`, `rolbypassrls = false`, `rolsuper = false`, DDL denied (`permission denied for schema public`). Password lives only in the gitignored `MyraTMS/.env.myra_app.production.local`. |
| 2 | `scripts/061_app_role_grants.sql` | ✅ Applied as `neondb_owner`. Grant probe: all 20 core tables selectable, zero `public` tables/views without SELECT for `myra_app`, `fn_myra_tenant_id()` callable. |
| 3 | Rotate Vercel production `DATABASE_URL` to `myra_app` + redeploy | ✅ `vercel env pull` confirms the new value; deployment built and aliased to `myratms.vercel.app`. **Note:** the *pre*-rotation value carried a trailing newline — the same defect class CLAUDE.md warns about for kill switches. The new value does not. |
| 4 | `scripts/060_harden_rls_policies.sql` | ✅ Applied as `neondb_owner`. Verified `unhardened: 0` of `total_policies: 30`; `rls_enabled_tables: 0` at that point. |
| 5 | **Day 1 — `ALTER TABLE tenant_audit_log ENABLE ROW LEVEL SECURITY`** | ✅ Committed 2026-10-08 ~22:10 UTC. PIT marker taken first: `utc_now = 2026-10-08T22:07:25.877Z`, `pg_current_wal_lsn = 0/BB35538`. Enabled inside a transaction with in-transaction verification of `pg_class.relrowsecurity` before COMMIT, per §3. |

**Day 1 smoke test (as `myra_app`, within the 5-minute window):** fail-closed and correct.

| Context | `SELECT count(*) FROM tenant_audit_log` | Expected |
|---|---|---|
| no context | 0 | 0 — fail closed ✅ |
| `app.current_tenant_id` = Myra | 9 | Myra's rows only ✅ |
| `app.current_tenant_id` = 999999 | 0 | 0 ✅ |
| `app.role = 'service_admin'` | 344 | all rows ✅ |

Writes: `service_admin` INSERT ✅, per-tenant INSERT in the caller's own tenant ✅
(the `withTenant` path `app/api/admin/config/[key]` uses), cross-tenant INSERT
**DENIED** (`new row violates row-level security policy`) ✅. All probes ran in
rolled-back transactions.

`GET /api/health` returned 200 with `db.ok = true` (69 ms) and `redis.ok = true`.

**Still outstanding from Day 1:**
- **Railway `myratms-workers` still has the `neondb_owner` `DATABASE_URL`.** The
  Railway CLI is unauthenticated in the session that did this work, so the
  worker host's rotation is still Patrice's to perform. Until then the workers
  keep BYPASSRLS, so RLS is a no-op for every worker path.
- The 4-hour monitor in §3 step 4 was not run to completion in-session.

**Harness gap found during Day 1 rehearsal (not an RLS defect):** the isolation
suite's `TEST_RLS_ENABLED=1` is table-agnostic — it assumes RLS is on for every
table it probes. Running it on `dev-tests` with only `tenant_audit_log` enabled
gave 13 pass / 5 fail, all five failing on `shippers`
(`tests/multitenant/isolation.test.ts:423`). Direct per-table probes of
`tenant_audit_log` were correct and fail-closed. The suite needs per-table
granularity before it can gate a partial rollout.

## §1 — Rollout schedule

| Day | Order | Table | Risk | Pre-flight gates | Status | Enabled at | Notes |
|---|---|---|---|---|---|---|---|
| 1 | 1 | `tenant_audit_log` | Lowest — append-only, low traffic, brand-new table | All writes go through audit helper that sets `app.current_tenant_id` | **Enabled** | 2026-10-08 ~22:10 UTC | Validates the rollout pattern itself. Smoke test green (§0a). Vercel is on `myra_app`; **Railway is not yet** |
| 2 | 2 | `tenant_users` | Low — config table, infrequent reads | All reads via `loadTenantUsers(tenantId)` helper | Pending | — | |
| 3 | 3 | `tenant_subscriptions` | Low — read at request resolution, written rarely | All reads via `loadSubscription(tenantId)` helper | Pending | — | |
| 4 | 4 | `consent_log` (Engine 2) | Low — consent records, write-heavy but per-call | **DEFERRED to M5** unless Engine 2 v1 stable by then | Deferred | — | Engine 2 table — Rule A applies |
| 5 | 5 | `dnc_list` (Engine 2) | Low — DNC checks, lookup-heavy | **DEFERRED to M5** unless Engine 2 v1 stable by then | Deferred | — | Engine 2 table — Rule A applies |
| 6 | 6 | `shippers` | Medium — every load create/update touches it | Phase 2.4 audit confirms every read uses `withTenant` | Pending | — | |
| 7 | 7 | `invoices` | Medium — finance/cron paths read it | Phase 2.4 audit confirms cron tenant iteration | Pending | — | |
| 8 | 8 | `carriers` | Medium-high — matching engine + assignment hot path | Phase 2.4 audit + matching engine review | Pending | — | |
| 9 | 9 | `quick_pay_advances` | Low — table doesn't exist yet (BILLING_DEFERRED) | Skip if table not created by M3 timing | N/A in current scope | — | Created by future billing session |
| 10 | 10 | `loads` | High — single hottest table; every UI route reads it | Phase 7.2 performance benchmark before enable; Phase 2.4 100% audit complete; staging soak 48h | Pending | — | Most critical enable; halt M3 if any anomaly |
| 11 | 11 | `agent_calls` (Engine 2) | High — voice agent log | **DEFERRED to M5** | Deferred | — | Engine 2 table — Rule A applies |
| 12 | 12 | `pipeline_loads` (Engine 2) | High — Engine 2 state machine | **DEFERRED to M5** | Deferred | — | Engine 2 table — Rule A applies |

> Tables 4, 5, 11, 12 (Engine 2) are listed in Patrice's approved order but per Rule A their RLS enable is sequenced into Phase M5, not M3. They appear here for completeness; Phase M3 effectively rolls out Tables 1–3, 6–8, 10 (8 tables over ~12 days with 2-day buffers between hot-path tables).

## §2 — Tables NOT in this schedule

These get RLS enabled too — they're just not in Patrice's approved priority list because they're medium-risk and follow naturally:

| Table | Cat | Day (estimate) | Notes |
|---|---|---|---|
| `users` | A-JOIN | 2 (alongside `tenant_users`) | RLS via JOIN to `tenant_users`; super-admins see all |
| `user_invites` | A | 5 | Per-tenant invites |
| `settings` | A | 5 | Cloned per-tenant per [TENANT_CONFIG_SEMANTICS.md](./TENANT_CONFIG_SEMANTICS.md) |
| `push_subscriptions` | A | 6 | Per-driver/per-tenant |
| `documents` | A | 7 | Per-tenant via load FK |
| `activity_notes` | A | 7 | Per-tenant |
| `notifications` | A | 7 | Per-tenant; broadcast logic preserved |
| `compliance_alerts` | A | 8 (alongside `carriers`) | Per-tenant carrier compliance |
| `drivers` | A | 8 (alongside `carriers`) | Per-tenant via carrier |
| `location_pings` | A | 10 (alongside `loads`) | Hot table, denorm tenant_id |
| `load_events` | A | 10 (alongside `loads`) | Hot table, denorm tenant_id |
| `check_calls` | A | 10 (alongside `loads`) | |
| `tracking_tokens` | A | 10 (alongside `loads`) | Token still globally unique |
| `delivery_ratings` | A | 10 (alongside `loads`) | |
| `shipper_report_log` | A | 7 (alongside `invoices`) | Per-tenant cron output |
| `workflows` | A | 6 (alongside `shippers`) | Per-tenant automation |
| `carrier_equipment` | A | 8 (alongside `carriers`) | |
| `carrier_lanes` | A | 8 (alongside `carriers`) | |
| `match_results` | A | 8 (alongside `carriers`) | |
| `quotes` | A | 6 (alongside `shippers`) | |
| `rate_cache` | A (initially) | 7 | Cross-tenant aggregate is later work |
| `quote_corrections` | A | 7 | Per-tenant accuracy learning |
| `integrations` | A | 6 | Per-tenant credentials; cred-encryption already in place |
| `tenant_config` | C | 3 (alongside `tenant_subscriptions`) | New table; RLS from day one |

In practice Phase M3 enables RLS in *batches* per day, not literally one table at a time. The "1 table/day" cadence refers to **new risk batches** — a day where a hot-path table comes online is a single risk event, even if 4 supporting tables come with it.

Final ramp:
- **Day 1:** `tenant_audit_log` (validate pattern; trivial table)
- **Day 2:** `users` + `tenant_users` + `tenant_subscriptions` + `tenant_config` (identity/config batch — all metadata)
- **Day 3:** All workflow + activity tables (`workflows`, `notifications`, `documents`, `activity_notes`, `settings`, `user_invites`, `push_subscriptions`)
- **Day 4:** Quoting + integrations batch (`quotes`, `rate_cache`, `quote_corrections`, `integrations`, `shipper_report_log`)
- **Day 5:** Shippers batch (`shippers`, `invoices`)
- **Day 7 (gap day):** Soak — observe Days 1–5 enabled tables for stability
- **Day 8:** Carriers batch (`carriers`, `compliance_alerts`, `drivers`, `carrier_equipment`, `carrier_lanes`, `match_results`)
- **Day 10 (gap day):** Soak — observe Days 8 enabled tables
- **Day 11:** Loads batch (`loads`, `location_pings`, `load_events`, `check_calls`, `tracking_tokens`, `delivery_ratings`)
- **Day 12 onwards:** Soak — 7 days clean before M4 starts

Total: ~12 working days for the TMS-core M3 rollout, with gap days. Engine 2 tables (`pipeline_loads`, `agent_calls`, `consent_log`, `dnc_list`, `shipper_preferences`, `lane_stats`, `personas`, `agent_jobs`, `compliance_audit`, `negotiation_briefs`) handled in Phase M5 on a similar 1-batch-per-day cadence.

## §3 — Per-batch enablement workflow

Each day's batch follows this exact procedure. Owner: whoever runs Session 8 (Phase M3 ramp).

### Pre-flight (the day before)

1. **Code audit** — grep all read paths against the batch's tables. Confirm every `SELECT` is inside a `withTenant()` wrapper or an `asServiceAdmin()` block. Document findings in this file's day entry.
2. **Test on staging** — apply the day's RLS policies to the staging DB. Run the multi-tenant integration test suite (`tests/multitenant/end-to-end.test.ts`). All tests pass = green light.
3. **Write the change ticket** — single-line ticket: "Day X — enable RLS on tables [list]". Include rollback command.
4. **Notify** — if Tenant 2 (Sudbury) is operating, send a heads-up to Sudbury ops. Tenant 1 ops gets notified for hot-path days (loads batch).

### Enablement (during chosen window — preferred Sunday morning ET, low freight activity)

1. **Backup PIT marker** — note the Neon PIT timestamp before enabling. If rollback needed within 24h, restore to this point.
2. **Open transaction** with rollback ready:
   ```sql
   BEGIN;
   ALTER TABLE x ENABLE ROW LEVEL SECURITY;
   ALTER TABLE y ENABLE ROW LEVEL SECURITY;
   -- Verify:
   SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('x', 'y');
   -- Confirm both = true
   COMMIT;  -- or ROLLBACK if anomaly
   ```
3. **Smoke test** within 5 minutes:
   - Hit 5 representative routes per enabled table
   - Confirm responses include data (not empty 200)
   - Confirm `tenant_audit_log` shows no `tenant_resolution_conflict` entries
4. **Monitor 4 hours**:
   - Vercel logs: check for elevated 4xx/5xx rates on enabled-table routes
   - User reports: any "I can't see my loads" reports trigger immediate rollback
   - DB query stats: any query going from <50ms to >500ms triggers investigation
5. **Sign off** — update this file's status column to `Enabled YYYY-MM-DD HH:MM ET` with notes column documenting any observations
6. **Proceed to next batch** the following day, OR pause if any issue surfaced

### Rollback (per table, within 4h window)

If any table causes problems:
```sql
ALTER TABLE x DISABLE ROW LEVEL SECURITY;
```
Application keeps working because it provides `tenant_id` explicitly. Resume cadence after fixing root cause.

If multiple tables in a batch are problematic, disable the entire batch:
```sql
BEGIN;
ALTER TABLE x DISABLE ROW LEVEL SECURITY;
ALTER TABLE y DISABLE ROW LEVEL SECURITY;
ALTER TABLE z DISABLE ROW LEVEL SECURITY;
COMMIT;
```

After 4h post-rollback, no Neon PIT restore needed (writes between enable and disable are valid; RLS only affected reads, and the application provides tenant filters).

## §4 — Acceleration rules

After **3 consecutive days of clean rollout**, Patrice may approve acceleration to 2 batches/day. Specific rules:

- Acceleration may NOT compress hot-path days (carriers batch, loads batch). Those stay isolated regardless of streak.
- Acceleration request goes through this doc — append to "Acceleration log" §5.
- Any anomaly during accelerated phase reverts to 1 batch/day for the remaining schedule.

## §5 — Acceleration log

(Append entries here as acceleration is granted/revoked.)

| Date | Decision | By | Reason |
|---|---|---|---|
| _none yet_ | | | |

## §6 — Anomaly log

(Append entries here as RLS-related issues are observed.)

| Date | Table(s) | Symptom | Action | Resolution |
|---|---|---|---|---|
| _none yet_ | | | | |

## §7 — Post-M3 validation

Before declaring M3 complete and proceeding to M4 ([ADR-004](./ADR-004-migration-strategy.md) §M4 gate):

- [ ] Every Cat A table has `relrowsecurity = true` in `pg_class`
- [ ] `tests/multitenant/end-to-end.test.ts` Scenario 1 (zero data crossing) passes for 7 consecutive days
- [ ] Phase 7.2 performance benchmark shows <10% degradation
- [ ] Phase 7.3 security audit returns 0 findings
- [ ] Anomaly log has been clean for 7 days
- [ ] Patrice signs off on M3 → M4 gate

End of RLS_ROLLOUT.md. Updated daily during Phase M3.
