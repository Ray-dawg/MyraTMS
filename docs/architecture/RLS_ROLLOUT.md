# RLS_ROLLOUT.md

> **Cadence:** Updated daily during Phase M3 rollout.
> **Last update:** 2026-05-01 (Session 1, Phase 0 — initial schedule)
> **Related:** [ADR-001](./ADR-001-tenant-isolation.md), [ADR-004](./ADR-004-migration-strategy.md), [SECURITY.md](./SECURITY.md)

This document is the live schedule and status log for Phase M3 — per-table Row-Level Security enablement. Default cadence: 1 table/day starting from lowest-traffic and progressing to hot-path tables. Patrice arbitrates acceleration.

## §1 — Rollout schedule

| Day | Order | Table | Risk | Pre-flight gates | Status | Enabled at | Notes |
|---|---|---|---|---|---|---|---|
| 1 | 1 | `tenant_audit_log` | Lowest — append-only, low traffic, brand-new table | All writes go through audit helper that sets `app.current_tenant_id` | Pending | — | Validates the rollout pattern itself |
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
