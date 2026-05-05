# ADR-001 — Tenant Isolation Strategy

| | |
|---|---|
| **Status** | **Approved 2026-05-01** (Patrice resolution round 2) |
| **Date** | 2026-05-01 |
| **Deciders** | Patrice Penda |
| **Drafter** | Claude (Opus 4.7) |
| **Supersedes** | none |
| **Superseded by** | none |
| **Companion docs** | [SECURITY.md](./SECURITY.md) §2 (RLS operational policy), [RLS_ROLLOUT.md](./RLS_ROLLOUT.md) (per-batch enable schedule) |

## Context

MyraTMS converts from single-tenant to multi-tenant SaaS (mega-mission, 2026-05-01). Three textbook tenant-isolation strategies exist and each has different cost/safety tradeoffs:

| Option | Strategy | Strongest property | Weakest property |
|---|---|---|---|
| **A** | Shared schema + row-level filtering by `tenant_id` (with Postgres RLS as defense-in-depth) | Cheapest to operate; trivial cross-tenant analytics | Noisy-neighbor risk; one connection pool serves all |
| **B** | Schema-per-tenant within one database | Cleaner per-tenant exports; per-schema backups; per-tenant migrations | Schema migrations multiplied by tenant count; cross-tenant reads need UNION ALL across schemas |
| **C** | Database-per-tenant | Hardest isolation; per-tenant scale + region | Operational cost dominates at low tenant counts; cross-tenant analytics requires CDC pipeline |

The codebase imposes constraints that bias the decision:

1. **Tagged-template SQL with no ORM.** Every query is hand-written `sql\`SELECT … WHERE id = ${id}\`` against a per-request `neon()` client. There is no mapper layer that could transparently inject `tenant_id` filters. A coding mistake = a query that crosses tenants.
2. **Single Neon project, shared connection pool.** Already operating against one Postgres database with serverless autoscaling. Schema-per-tenant or DB-per-tenant requires either provisioning multiple Neon projects (cost + ops complexity) or running separate `search_path` switching per request (footgun-prone with connection pooling).
3. **Cross-tenant aggregates are a stated value-prop.** Lane intelligence and rate index across tenants is part of the AutoBroker pitch (per AXIOM thesis, even though that doc is missing — confirmed via mega-prompt §Phase 6.3). UNION across N schemas/databases is materially harder than `WHERE tenant_id IN (...)`.
4. **Edge-runtime middleware** does signature verification. We cannot easily switch Postgres connection strings per request inside middleware (would force Node-runtime middleware and lose Vercel Functions performance characteristics).
5. **Engine 2 BullMQ workers** share the same database. Schema-per-tenant would require workers to dynamically `SET search_path` per job — a pattern that's known to break under BullMQ retries with stale connections.

## Decision

**Adopt Option A: shared schema with `tenant_id` filtering on every Category A table, backed by Postgres Row-Level Security policies as defense-in-depth.**

Document explicit triggers that escalate to Option B (schema-per-tenant). Do not pre-build for B — only migrate when one of the triggers fires.

### How Option A is implemented in this codebase

1. **Column.** Every Category A table (per `TENANTING_AUDIT.md` §2) gets `tenant_id BIGINT NOT NULL REFERENCES tenants(id)`. Migration 028 adds the column with `DEFAULT 1` (Tenant 1 = Myra primary), backfills, then drops the default in a later phase (per ADR-004).
2. **Index.** Composite indexes `(tenant_id, hot_column)` on every hot path (per `TENANTING_AUDIT.md` §6).
3. **RLS policy.** Every Category A table gets:
   ```sql
   ALTER TABLE x ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON x
     FOR ALL
     USING (tenant_id = current_setting('app.current_tenant_id')::BIGINT);
   CREATE POLICY service_admin_bypass ON x
     FOR ALL
     USING (current_setting('app.role', true) = 'service_admin');
   ```
   The `service_admin_bypass` policy is the **explicit** escape hatch for super-admin queries (cross-tenant analytics, support troubleshooting, billing reconciliation). Triggering it requires setting `app.role = 'service_admin'` in the same transaction — and every such invocation logs to `tenant_audit_log` per ADR-002 §Service-admin escalation.
4. **Application context.** A new `lib/db/tenant-context.ts` provides `withTenant(tenantId, callback)` that opens a transaction, runs `SET LOCAL app.current_tenant_id = $tenantId`, then invokes the callback. All `getDb()` calls in API routes are migrated to `withTenant`. Calls without a tenant context throw at the wrapper level (defense in depth #2).
5. **Backstop.** If both the tenant filter and the application context are missing (e.g., a developer writes `getDb().sql\`SELECT * FROM loads\`` directly), RLS returns 0 rows because `current_setting('app.current_tenant_id', true)` is NULL and the cast fails — query returns empty rather than leaking. RLS is the catch.
6. **Connection pooling.** Stay on Neon's serverless autoscaling. Add per-tenant `statement_timeout` defaults (Phase 7.2 task).

### Triggers to migrate from A → B (schema-per-tenant)

Migration is initiated when **any one** of the following is true:

| # | Trigger | How we measure |
|---|---|---|
| 1 | A single tenant exceeds 30% of Postgres CPU sustained for 7 days | Neon metrics dashboard, weekly review |
| 2 | A SaaS customer requires data residency in a region different from Tenant 1's primary | Contract clause |
| 3 | A regulated tenant (e.g., a brokerage with FCA/SOC 2 obligations) requires schema-level isolation as part of audit | Customer SOC 2 Type II report or compliance officer demand |
| 4 | Active tenant count exceeds 50 (proxy for "shared pool noise becomes hard to debug") | `SELECT count(*) FROM tenants WHERE status = 'active'` |

When triggered, the migration path is:
- Step 1: Provision new Neon project (or new schema in same project)
- Step 2: Logical replication from shared schema to new schema with `WHERE tenant_id = $X`
- Step 3: Cut over connection routing for that tenant via `tenant_config.db_url_override`
- Step 4: Drop tenant's rows from shared schema after 7-day soak

This is **not** built in Phase 1. It is a documented path that the architecture supports without rework — adding `db_url_override` to `tenant_config` and routing `withTenant()` to honor it covers the migration handle.

## Consequences

### Positive

- **Lowest migration cost.** Adds one column + one index + one RLS policy per table; no infrastructure provisioning.
- **Cross-tenant analytics free.** `WHERE tenant_id IN (1,2,3)` works out of the box for super-admin views and cross-tenant lane intelligence.
- **Defense in depth.** Application bug ≠ data leak. RLS catches missing `WHERE tenant_id = X` filters at the DB layer.
- **Single backup / point-in-time restore** — operational simplicity for the first 50 tenants.
- **Engine 2 workers** stay simple — every job carries `tenantId`, queries scope themselves via `withTenant()`.

### Negative

- **Noisy neighbor risk.** One tenant's slow query can degrade response times for all. Mitigated by: per-query `statement_timeout`, Neon serverless autoscaling, and per-tenant rate-limiting at API layer (Phase 4).
- **Per-tenant point-in-time restore is harder.** Restoring just Tenant 5 means: PIT-restore to staging Neon, `SELECT … WHERE tenant_id = 5`, replay to prod. No native Neon PIT-by-tenant. Documented as accepted operational pain.
- **Schema migrations affect all tenants simultaneously.** If a Phase-N migration breaks, it breaks for everyone. Mitigated by: staging-first rollout (every migration tested against staging clone of prod), reversible scripts, off-hours maintenance windows.
- **RLS performance overhead.** Every query incurs `current_setting()` lookup + policy evaluation. Postgres handles this efficiently for simple equality predicates. Phase 7.2 benchmarks against single-tenant baseline; budget is <10% degradation.
- **Operational dependency on RLS being correct.** A subtle policy bug (e.g., forgetting `service_admin` bypass in a new table) could either leak or break. Mitigated by: a Phase 1.6 test suite that verifies every Category A table has both policies and rejects cross-tenant queries.

### Neutral

- We do not foreclose Option B. The migration path is clear and partial migration is supported (one tenant at a time can move to a dedicated schema while others stay shared).
- We do not foreclose Option C either. A regulated tenant could move to a dedicated Neon project via the same `db_url_override` mechanism.

## Alternatives considered

### Option B (schema-per-tenant)

**Rejected for now**, would-revisit-when-trigger-fires.

Pros:
- Per-tenant migrations possible (e.g., enable a beta feature for one tenant by adding a column to their schema only).
- Per-tenant backups / point-in-time restore at the schema level.
- Cleaner data deletion (DROP SCHEMA on tenant churn).

Cons in this codebase:
- Tagged-template SQL doesn't naturally support `search_path` switching mid-query. Would require a wrapper that does `SET LOCAL search_path = tenant_$X` per transaction, with all the same context-injection plumbing as Option A.
- Schema-aware migrations: every `ALTER TABLE` has to fan out to N schemas. With BullMQ Engine 2 workers running across tenants, missing a schema during a partial deploy creates inconsistency.
- Cross-tenant analytics requires UNION ALL across N schemas, which Postgres doesn't optimize well past ~10 schemas.
- Connection pool churn: opening a connection in tenant-A's `search_path` and reusing it for tenant B requires explicit `RESET search_path`, a known footgun in production pools.

If the triggers above fire, the migration is mechanical: existing `withTenant(id)` becomes `withTenant(id) → SET search_path = tenant_$id` in addition to RLS. The application code doesn't change.

### Option C (database-per-tenant)

**Rejected for now**, would-revisit-only-for-specific-regulated-customers.

Pros:
- Hardest isolation. Compromise of one tenant's credentials doesn't expose others.
- Per-tenant scale + per-tenant region.
- Clear blast radius for incidents.

Cons in this codebase:
- Operationally expensive at low tenant counts. Each Neon project has its own backups, logical replication slots, monitoring, alerting.
- Cross-tenant analytics requires a centralized warehouse with CDC from N databases — exactly the warehouse work Patrice has descoped to a future session.
- Engine 2 BullMQ workers would need to maintain N connection pools, one per tenant — Redis-side this is fine, but the worker's database connection logic becomes per-job lookups.
- Tenant onboarding becomes a 10-minute provisioning step instead of an `INSERT INTO tenants`.

Reserved for a future ADR addendum if Trigger #2 (data residency) or Trigger #3 (regulated customer audit) fires.

### Hybrid: Option A for Tenants 1–N, Option B for designated tenants

**Considered but not adopted as the default.** This is the implicit migration path described above (a tenant moves to its own schema when triggered). The default is Option A; hybrid happens organically as triggers fire.

## Out-of-scope decisions deferred

- **Per-tenant Postgres roles** for additional defense-in-depth (each tenant's API runs as a different role). Adds operational complexity for marginal extra safety; Option A's `app.current_tenant_id` setting + RLS already gives the property we need.
- **`pg_policies` view monitoring** for policy drift. Phase 7.3 deliverable, not Phase 1.
- **Per-tenant Neon branches for staging environments.** Useful for SaaS customer staging environments; revisit when the first Pro/Enterprise customer asks.

## Validation

This ADR is satisfied when:
1. Phase 1.3 migration 030 enables RLS on every Category A table.
2. Phase 1.6 integration test suite (`tests/multitenant/isolation.test.ts`) demonstrates: (a) tenant A cannot read tenant B data via any code path, (b) `service_admin` escalation works AND is logged, (c) missing tenant context returns 0 rows rather than throws or leaks.
3. Phase 7.2 performance benchmark shows <10% degradation on hot-path queries.
