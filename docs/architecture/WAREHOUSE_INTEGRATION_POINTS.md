# WAREHOUSE_INTEGRATION_POINTS.md

> **Purpose:** Map the integration points where a future analytics
> warehouse will plug into MyraTMS. Per Patrice Confirmation 1 (Answer 5,
> resolved 2026-05-01), Phase 6 of the multi-tenant rollout is **NOT** a
> warehouse build — it is a 30-minute documentation deliverable that
> lists the touchpoints so a future dedicated warehouse-build session
> doesn't have to rediscover them.
>
> **Scope:** This document is forward-looking; nothing in here is built
> in Sessions 1–8 of the multi-tenant rollout. The build is its own
> session.
>
> **Authoritative companion docs:**
> - [ADR-001 §Future migration to schema-per-tenant](./ADR-001-tenant-isolation.md)
> - [STACK_DRIFT_REPORT.md §6](./STACK_DRIFT_REPORT.md) (warehouse-build deferral rationale)

## §1 — Source of truth: Neon logical replication

MyraTMS runs on Neon Postgres. The tenant schema (after migrations
027–031) is the canonical write store. The warehouse will consume
changes via **Neon logical replication**:

- `wal_level=logical` is enabled by default on Neon Pro plans
- Publication: a future `myra_warehouse` publication selects every
  Cat A table (per migration 029) plus the platform-metadata tables
  (`tenants`, `tenant_subscriptions`, `tenant_audit_log`)
- Subscription side runs in the warehouse VPC (separate Neon project,
  separate Vercel project, or external compute — to be decided in the
  warehouse-build session)

**No code in MyraTMS needs to change to enable replication.** The
publication is created by an operational SQL script; the subscription
side is greenfield warehouse work.

## §2 — Tenant-id propagation guarantees (THE key invariant)

After migration 028, every Cat A table has `tenant_id BIGINT NOT NULL`.
This means **any warehouse aggregation that reads from a single Cat A
table can group by `tenant_id` without joins**. This is the single most
important property for warehouse modeling — it eliminates the question
"which tenant does this row belong to?" at the source.

Tables without `tenant_id` are intentional and must be handled
explicitly in the warehouse layer:

| Table | Why no tenant_id | Warehouse handling |
|---|---|---|
| `distance_cache`, `fuel_index`, `loadboard_sources` | Global lookup tables, shared across tenants | Materialize once in the warehouse; do not partition by tenant_id |
| `tenants`, `tenant_subscriptions`, `tenant_audit_log` | Tenant metadata themselves — primary key IS the tenant relationship | Use `id` (tenants) or `tenant_id` (subs/audit) as partition key directly |
| `users` | Cross-tenant by design (one user, multiple tenants via `tenant_users`) | Join through `tenant_users` to fan out per-tenant rows; do not denormalize into a single row keyed by tenant |

## §3 — Recommended raw-zone schema

The warehouse should mirror MyraTMS table shapes 1:1 in a `raw_*`
schema. Suggested naming convention:

```
warehouse.raw_loads          ← mirror of myratms.loads
warehouse.raw_carriers       ← mirror of myratms.carriers
warehouse.raw_invoices       ← mirror of myratms.invoices
warehouse.raw_tenant_usage   ← mirror of myratms.tenant_usage (after migration 031)
warehouse.raw_tenant_audit   ← mirror of myratms.tenant_audit_log
…
```

Each `raw_*` table has the same columns plus three replication-meta
columns:

```sql
_replicated_at  TIMESTAMPTZ  -- when the warehouse received the row
_op             CHAR(1)      -- 'I'/'U'/'D' from logical replication
_lsn            PG_LSN       -- log sequence number for ordering
```

These are added by the replication consumer, not by MyraTMS.

## §4 — dbt model boundaries

Recommended dbt model layering (when the warehouse build picks up):

```
raw_*           (1:1 mirrors, no transforms)
   ↓
stg_*           (cleanups: types, NULL handling, simple flags)
   ↓
int_*           (joins across raw_* — e.g. int_loads_with_carriers)
   ↓
fct_*, dim_*    (star schema for BI tools — partitioned BY tenant_id)
   ↓
mart_*          (per-business-area marts: ops, finance, capital)
```

**Partition key contract:** every `fct_*` and `dim_*` table that holds
per-tenant data MUST include `tenant_id` as a leading column AND must
be partitioned/clustered by `tenant_id` first, then by `event_date`
(or equivalent). This guarantees that a "show me Acme's Q3 metrics"
query stays cheap as the warehouse grows.

## §5 — Aggregation patterns and tenant safety

Cross-tenant aggregations (the platform owner sees all of Myra's
customers' aggregate metrics for board decks, lane intelligence, etc.)
have specific safety requirements:

### 5.1 — Aggregations that are SAFE to expose cross-tenant

- Total platform GMV, total platform load count
- Lane-level aggregates ("Toronto → Montreal corridor average rate
  across all tenants") — granted that the underlying tenant set is
  ≥ N (anti-deanonymization threshold; suggest N=5)
- Cohort metrics (loads booked in week X, where week X is calendar)

### 5.2 — Aggregations that must NEVER cross tenants

- Carrier rates broken out per shipper (would leak which tenants
  use which carriers)
- Per-tenant performance metrics in any view a customer sees (only
  the tenant itself sees its own metrics)
- Any per-tenant audit-log details

### 5.3 — Mart access control

The platform-owner-facing dashboard reads `mart_platform_*` views
(unrestricted). Customer-facing dashboards read `mart_tenant_*` views
that take a `tenant_id` parameter and only return rows for that
tenant. Implementation: SQL views with `WHERE tenant_id =
current_setting('app.current_tenant_id', true)::bigint`, mirroring
the RLS pattern in MyraTMS.

## §6 — Hot-path counters: bridging Redis and the warehouse

The usage tracker (`lib/usage/tracker.ts`) writes per-tenant counters
to Redis (Upstash). Migration 031 added `tenant_usage` to durably
persist these. The intended flow for warehouse integration:

```
Redis counters (live, ms latency)
     │
     │ daily aggregation cron (Phase 4.4 follow-up — not yet built)
     ▼
myratms.tenant_usage          ← logical replication source
     │
     ▼
warehouse.raw_tenant_usage
     │
     ▼
mart_platform_usage / mart_tenant_usage
```

The aggregation cron is documented as a deferred follow-up in
SESSION_5_SUMMARY.md §3. When built, it should follow the
`forEachActiveTenant` pattern from Session 3.

## §7 — Audit log → warehouse: the compliance event stream

`tenant_audit_log` is written by every cross-tenant escape
(`asServiceAdmin`, `resolveTrackingToken`, super-admin tenant CRUD,
config edits, purge schedule/cancel, exports, onboarding). It is the
canonical platform audit trail.

Replication of this table to the warehouse gives:

- A long-retention audit store independent of MyraTMS's own backup window
- A queryable surface for compliance reporting (e.g., "show every
  service_admin invocation in the last 90 days, grouped by reason")
- Anomaly detection inputs (sudden spike in `tenant_purge_scheduled`
  events, unusual access patterns, etc.)

The audit log is append-only by convention — no UPDATE or DELETE paths
exist in production code. A warehouse consumer can rely on this:
`_op='U'` and `_op='D'` rows in `raw_tenant_audit` should NEVER appear
and indicate either a Postgres bug or a manual DB intervention worth
investigating.

## §8 — Schema-per-tenant migration path (optional future)

ADR-001 documents a schema-per-tenant pivot as a future option if RLS
proves insufficient. If that day comes, the warehouse implications:

- Each tenant becomes a separate Postgres schema (`tenant_2.loads`,
  `tenant_3.loads`, …)
- Logical replication needs one publication per schema OR a
  multi-schema publication with appropriate filter
- The `raw_*` zone in the warehouse must un-fan-out the per-schema
  tables back into one `tenant_id`-keyed shape (the warehouse layer
  takes on the work that RLS does today in MyraTMS)

This is documented but NOT planned. Schema-per-tenant migration would
be its own multi-session project.

## §9 — Open items for the warehouse build session

When that session lands, it will need to decide:

| # | Decision |
|---|---|
| 1 | Replication consumer technology — Debezium / Materialize / managed Neon Replication / custom Bun script |
| 2 | dbt project location — same repo as MyraTMS or separate `myra-warehouse` repo |
| 3 | BI tool — Metabase / Hex / Mode / Looker / DIY dashboards |
| 4 | Anti-deanonymization threshold N for cross-tenant aggregates (default proposal: 5) |
| 5 | Audit-log retention policy in the warehouse (suggest 7 years for SOC 2) |
| 6 | Whether to build the daily Redis→tenant_usage aggregator before or after the warehouse pipeline (suggest before, since the warehouse needs it) |

Out-of-scope for the multi-tenant rollout (Sessions 1–8). End of doc.
