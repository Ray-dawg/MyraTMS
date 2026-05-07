# PERFORMANCE_NOTES.md

> **Purpose:** Document the expected performance impact of the Phase 2
> withTenant refactor and call out the load-test plan that should run
> before Phase M3 (RLS enable). Author: Session 7 — Phase 7.2.
>
> **Status:** Documentation-only. No load tests executed in Session 7.
> Tests are scheduled into Phase 7.3 (RLS gate) and the staging smoke
> in Phase 8 deployment.

## §1 — Architectural perf delta

### Before Session 3 (HTTP-mode `getDb`)

```ts
const sql = getDb()  // neon(url) — opens a new HTTPS connection per call
const rows = await sql`SELECT ... FROM loads WHERE ...`
```

- One HTTPS roundtrip per query (no transaction, no session state)
- Connection setup cost paid every query
- No way to set `SET LOCAL app.current_tenant_id` (HTTP mode resets
  every call)

### After Session 3 (Pool/WebSocket `withTenant`)

```ts
await withTenant(tenantId, async (client) => {
  await client.query("SELECT ... FROM loads WHERE id = $1", [id])
  await client.query("UPDATE loads SET ... WHERE id = $1", [id])
})
```

- One WebSocket connection per request (acquired from a Neon pool)
- BEGIN / SET LOCAL / COMMIT bookend each tenant-scoped block
- All queries inside a single `withTenant` block reuse the same
  connection — no per-query setup cost for the 2nd, 3rd, … query

### Expected delta

| Workload | Before (HTTP) | After (Pool) | Notes |
|---|---|---|---|
| Single-query route (e.g. GET /api/loads/[id]) | 1 HTTPS RTT | 1 WS connect + tx | **Slightly slower** for single-query routes — the BEGIN/SET/COMMIT overhead doesn't amortize over a single query |
| Multi-query route (e.g. POST /api/loads with side-effects) | N HTTPS RTTs | 1 WS connect + 1 tx with N queries | **Faster** — the second query onward is in-process, no network setup |
| Cron handler iterating tenants | Not previously implemented | 1 service-admin tx + per-tenant tx | New capability; baseline cost is the loop, not the tx pattern |
| Public tracking-token routes | 1 HTTPS RTT | 1 WS resolveTrackingToken + 1 WS withTenant | **Slower** — two sequential transactions where there used to be one query |

The single-query route slowdown is real but measurable in tens of
milliseconds, not hundreds. The acceptable trade per ADR-001 is "≤10%
p95 regression on hot routes" — the staging load test before Phase M3
must confirm this.

## §2 — Hot-path queries to monitor

Per Session 3 conversion catalog (API_REFACTOR_LOG.md), these routes
are the highest-traffic single-query handlers and the most sensitive
to the per-query overhead:

| Route | Approx. shape |
|---|---|
| `GET /api/loads` | One LIMIT 50 SELECT |
| `GET /api/loads/[id]` | One row SELECT |
| `GET /api/notifications` | One LIMIT 25 SELECT |
| `GET /api/finance/summary` | Two SUMs |
| `GET /api/me/tenant` (Session 6 new) | One JOIN-ish SELECT |

These should be load-tested with the staging branch before Phase M3.
A 10% p95 regression on any of them is the acceptance threshold.

## §3 — Cron fan-out cost

Session 3 introduced `forEachActiveTenant` which serially iterates
active tenants and runs the per-tenant work inside `withTenant`. For
N tenants, the cron's wall-clock time is approximately:

```
T = T_admin_enumerate + N * (T_per_tenant_setup + T_per_tenant_work)
```

Where:
- `T_admin_enumerate` ≈ 50–100ms (one asServiceAdmin SELECT)
- `T_per_tenant_setup` ≈ 20–40ms (Pool acquire + BEGIN + SET + COMMIT)
- `T_per_tenant_work` is whatever the original cron's body cost

For the current N=2 (Myra + Sudbury when provisioned), this is well
under any timeout. The relevant concern is when N > 50 — the
`exception-detect` cron runs every 5 minutes; at 50ms × 100 tenants
= 5s of wasted setup overhead per fire.

**Mitigation if N becomes a problem (NOT in scope this session):**
- Parallelize the loop with `Promise.all` (bounded concurrency, e.g.
  10 at a time) — Pool size on Neon Pro is 100 by default, so this is
  fine
- Migrate the heaviest cron (`shipper-reports` monthly) to Vercel
  Workflow for durable retry, since it's the longest-running per-tenant

The current `forEachActiveTenant` helper is intentionally serial —
swap to parallel when measurable, not preemptively.

## §4 — Cache-key tenant scoping cost

Session 3 changed `/api/loadboard/search` from a single global Redis
cache key to a tenant-scoped key:

```ts
// before
const cacheKey = `loadboard:search:${origin}:${destination}:${equipment}`
// after
const cacheKey = `loadboard:search:t${tenantId}:${origin}:${destination}:${equipment}`
```

Implication: each tenant has its own cache namespace. Cache hit rate
goes down (no cross-tenant sharing) but isolation is correct.

For the Myra-only deployment today, this is functionally identical —
N=1 means the namespace prefix doesn't change anything. With N>1
tenants the cache fill cost multiplies linearly. Not a concern at
expected platform scale.

## §5 — Connection pool sizing

`lib/db/tenant-context.ts` currently creates ONE Pool per Node process
with default Neon settings (max=100 concurrent connections). On
Vercel serverless, each cold-start spawns a fresh process and a fresh
Pool. Hot containers reuse the pool across requests.

The Pool is process-lifetime — no explicit close. Vercel functions
that idle out drop the pool with the container. This is correct for
serverless; long-running daemons (the BullMQ workers in Engine 2)
need their own Pool reuse story which is already handled in
`lib/pipeline/db-adapter.ts`.

**Open question for Phase M3:** does the Pool need a `max` cap below
Neon's 100 default? Likely YES if a high-concurrency burst spawns
50+ Vercel function instances simultaneously, each with their own
pool — that's 50 × 100 = 5000 potential connections, well above the
~10k Neon Pro hard limit. Mitigation: cap pool max at 5–10 per
process to leave headroom.

This is a Phase M3 pre-flight item, not a Session 7 build.

## §6 — Recommended load-test scenarios (for Phase 7.3 / Phase 8)

When the load test runs (likely k6 or autocannon against staging):

| Scenario | Command shape | Pass criterion |
|---|---|---|
| Baseline single-query route | `k6 run --vus=20 --duration=60s GET /api/loads/LD-001` | p95 < 200ms, p99 < 500ms |
| Multi-query route under load | `k6 run --vus=20 POST /api/loads` (with body) | p95 < 400ms |
| Cron fan-out timing | Manually trigger `/api/cron/exception-detect` with auth header against staging with 5+ tenants | < 30s wall-clock |
| Cache-key isolation | Simulate two tenants hitting `/api/loadboard/search` with same params; confirm second's first request is a miss | Two distinct Redis keys observed |
| Pool exhaustion (Phase M3 pre-flight) | Sustained 100 concurrent connections | No `connection_limit_exceeded` errors |

These are deliberate gates BEFORE Phase M3 RLS enable. Documented for
the operator running the staging promotion.

## §7 — Index audit checklist

Migrations 027/028 added composite indexes on `(tenant_id, …)` for
every Cat A table. Pre-flight before Phase M3:

```sql
-- Confirm every Cat A table has at least one tenant-leading index.
SELECT
  c.relname AS table_name,
  i.relname AS index_name,
  pg_get_indexdef(i.oid) AS def
FROM pg_class c
JOIN pg_index ix ON c.oid = ix.indrelid
JOIN pg_class i  ON i.oid = ix.indexrelid
WHERE c.relkind = 'r'
  AND c.relname IN (
    'loads', 'carriers', 'shippers', 'invoices', 'documents',
    'drivers', 'tracking_tokens', 'exceptions', 'compliance_alerts',
    'workflows', 'notifications', 'check_calls', 'load_events',
    'activity_notes', 'match_results', 'carrier_equipment',
    'carrier_lanes', 'quotes', 'quote_corrections', 'rate_cache',
    'integrations', 'settings', 'user_invites', 'tenant_config',
    'tenant_users', 'tenant_audit_log', 'tenant_subscriptions',
    'tenant_usage'
  )
  AND pg_get_indexdef(i.oid) ILIKE '%tenant_id%'
ORDER BY c.relname, i.relname;
```

A row in this query for every listed table is the green light. Run on
staging post-031 apply.

## §8 — Watchlist for Phase M3 (RLS enable)

When the policies created in 029 are ENABLED in batches per RLS_ROLLOUT.md:

- **Query plans change.** `EXPLAIN ANALYZE` of hot-path queries should
  show `Filter: tenant_id = 2::bigint` injected by RLS. Filter
  selectivity should leverage the composite indexes from 028.
- **Anti-pattern alert.** Any query that was `SELECT ... FROM loads`
  without a `WHERE tenant_id` clause continues to work post-RLS but
  produces a different plan — the tenant_id filter moves from app
  layer to RLS-injected predicate. If the indexes don't include
  tenant_id leading, this becomes a scan. The §7 index audit catches
  this before flip.
- **Connection pool state cleanliness.** RLS reads
  `current_setting('app.current_tenant_id')` per query. If the SET
  LOCAL inside `withTenant` ever fails to apply, EVERY query in that
  transaction sees zero rows (RLS denies all). This is fail-closed and
  desirable — but it means an AbortError mid-BEGIN will produce
  empty result sets, not partial data. Document for ops.

End of perf notes.
