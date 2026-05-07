# API_REFACTOR_LOG.md

> **Session:** 3 — Phase 2 (Application middleware + auth refactor)
> **Started:** 2026-05-01
> **Owner:** Claude (Opus 4.7) under Patrice direction
> **Scope:** All 88 API routes in `MyraTMS/app/api/**/route.ts` migrated from
> single-tenant `getDb()` (HTTP-mode tagged templates) to multi-tenant
> `withTenant(tenantId, async (client) => …)` (Pool/WebSocket parameterized).

## Refactor pattern

### Before (single-tenant, HTTP mode)

```ts
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const sql = getDb()
  const rows = await sql`SELECT * FROM loads WHERE id = ${id}`
  return NextResponse.json(rows[0])
}
```

### After (multi-tenant, Pool/WebSocket)

```ts
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"

export async function GET(req: NextRequest) {
  const ctx = requireTenantContext(req)
  const row = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM loads WHERE id = $1`,
      [id],
    )
    return rows[0]
  })
  return NextResponse.json(row ?? null)
}
```

### Mechanical conversion rules

| From | To |
|---|---|
| `import { getDb } from "@/lib/db"` | `import { withTenant } from "@/lib/db/tenant-context"` |
| `getCurrentUser(req)` (for auth check) | `requireTenantContext(req)` (preferred where tenant id is needed) |
| `const sql = getDb()` | (deleted) |
| `await sql\`SELECT … WHERE id = ${id}\`` | `await client.query('SELECT … WHERE id = $1', [id])` (inside `withTenant` callback) |
| Tagged-template interpolation `${value}` | Numbered placeholders `$1`, `$2`, … with values array |
| `sql.unsafe(...)` (dynamic field PATCH) | Build parameterized SET clause + use `client.query` with concatenated string + array |
| Raw `SELECT * FROM ...` (no tenant filter) | RLS will scope rows post-Phase-M3 — no manual `WHERE tenant_id = …` needed (RLS policy enforces via `app.current_tenant_id` setting) |

### Routes that intentionally do NOT use `withTenant`

| Route | Why |
|---|---|
| `app/api/auth/login/route.ts` | Pre-tenant — looks up user across all tenants by email |
| `app/api/auth/driver-login/route.ts` | Pre-tenant — looks up driver across all tenants by PIN |
| `app/api/auth/logout/route.ts` | No DB access |
| `app/api/auth/me/route.ts` | Reads JWT only, no DB access |
| `app/api/auth/accept-invite/route.ts` | Pre-tenant — invite token lookup before user has tenant context |
| `app/api/auth/invite/route.ts` | Uses `requireTenantContext` (tenant-scoped invite creation) |
| `app/api/drivers/accept-invite/route.ts` | Pre-tenant — invite token lookup |
| `app/api/drivers/invite/[token]/route.ts` | Pre-tenant — invite token validation |
| `app/api/tracking/[token]/**` | Token-based, uses `resolveTrackingToken` then `withTenant` for follow-on queries |
| `app/api/rate/[token]/route.ts` | Token-based public rating page; uses `resolveTrackingToken` flow |
| `app/api/cron/**` | Cron handlers iterate over all tenants — see CRON_REFACTOR section below |
| `app/api/webhooks/retell-callback/route.ts` | External webhook; tenant resolved from payload metadata via service-admin lookup |

## Per-route refactor tracking

Status legend: ⬜ pending · 🔄 in progress · ✅ done · ⛔ deferred (not converted) · 🅿 pre-tenant (no withTenant needed)

### auth/* (5 routes)
| Route | Status | Notes |
|---|---|---|
| `auth/login/route.ts` | 🅿 | Cross-tenant lookup by email — pre-tenant |
| `auth/driver-login/route.ts` | 🅿 | Cross-tenant driver PIN lookup |
| `auth/logout/route.ts` | 🅿 | No DB |
| `auth/me/route.ts` | 🅿 | JWT-only |
| `auth/invite/route.ts` | ✅ | Tenant-scoped invite creation |
| `auth/accept-invite/route.ts` | 🅿 | Pre-tenant token validation |

### loads/* (12 routes)
| Route | Status | Notes |
|---|---|---|
| `loads/route.ts` | ✅ | GET list + POST create |
| `loads/[id]/route.ts` | ✅ | GET one + PATCH (uses sql.unsafe) |
| `loads/[id]/assign/route.ts` | ✅ | Driver assignment |
| `loads/[id]/events/route.ts` | ✅ | Load event timeline |
| `loads/[id]/invoice/route.ts` | ✅ | Invoice generation |
| `loads/[id]/location/route.ts` | ✅ | GPS ping (driver) |
| `loads/[id]/match/route.ts` | ✅ | Carrier matching |
| `loads/[id]/pod/route.ts` | ✅ | POD upload |
| `loads/[id]/send-tracking/route.ts` | ✅ | Tracking email |
| `loads/[id]/tracking-token/route.ts` | ✅ | Token issuance |
| `loads/bulk-match/route.ts` | ✅ | Bulk carrier match |
| `loads/map/route.ts` | ✅ | Map data |
| `loads/request/route.ts` | ✅ | Driver load request |

### carriers/* (3 routes)
| Route | Status | Notes |
|---|---|---|
| `carriers/route.ts` | ✅ | GET list + POST create |
| `carriers/[id]/route.ts` | ✅ | GET one + PATCH |
| `carriers/[id]/rate/route.ts` | ✅ | Rate adjustment |

### shippers/* (2 routes)
| Route | Status | Notes |
|---|---|---|
| `shippers/route.ts` | ✅ | GET list + POST create |
| `shippers/[id]/route.ts` | ✅ | GET one + PATCH |

### drivers/* (5 routes)
| Route | Status | Notes |
|---|---|---|
| `drivers/route.ts` | ✅ | GET list + POST create |
| `drivers/[id]/route.ts` | ✅ | GET one + PATCH |
| `drivers/me/loads/route.ts` | ✅ | Driver self-loads |
| `drivers/invite/route.ts` | ✅ | Tenant-scoped invite |
| `drivers/invite/[token]/route.ts` | 🅿 | Pre-tenant token lookup |
| `drivers/accept-invite/route.ts` | 🅿 | Pre-tenant acceptance |

### invoices/* (1 route)
| Route | Status | Notes |
|---|---|---|
| `invoices/route.ts` | ✅ | GET list + POST create |

### documents/* (4 routes)
| Route | Status | Notes |
|---|---|---|
| `documents/route.ts` | ✅ | GET list + POST create |
| `documents/[id]/route.ts` | ✅ | GET + DELETE |
| `documents/upload/route.ts` | ✅ | Vercel Blob upload + DB insert |
| `documents/download-all/route.ts` | ✅ | Bulk download |

### notifications/* (4 routes)
| Route | Status | Notes |
|---|---|---|
| `notifications/route.ts` | ✅ | GET list + POST create |
| `notifications/[id]/read/route.ts` | ✅ | Mark read |
| `notifications/read-all/route.ts` | ✅ | Mark all read |
| `notifications/stream/route.ts` | ✅ | SSE stream |

### exceptions/* (3 routes)
| Route | Status | Notes |
|---|---|---|
| `exceptions/route.ts` | ✅ | GET list |
| `exceptions/[id]/route.ts` | ✅ | GET + PATCH |
| `exceptions/detect/route.ts` | ✅ | Manual exception scan |

### workflows/* (2 routes)
| Route | Status | Notes |
|---|---|---|
| `workflows/route.ts` | ✅ | GET list + POST create |
| `workflows/[id]/route.ts` | ✅ | GET + PATCH + DELETE |

### check-calls/* (1 route)
| Route | Status | Notes |
|---|---|---|
| `check-calls/route.ts` | ✅ | GET + POST |

### compliance/* (3 routes)
| Route | Status | Notes |
|---|---|---|
| `compliance/alerts/route.ts` | ✅ | Alert list |
| `compliance/verify/route.ts` | ✅ | FMCSA single |
| `compliance/batch/route.ts` | ✅ | FMCSA bulk |

### tracking/* (5 routes)
| Route | Status | Notes |
|---|---|---|
| `tracking/[token]/route.ts` | ✅ | Public — uses `resolveTrackingToken` |
| `tracking/[token]/events/route.ts` | ✅ | Public — uses `resolveTrackingToken` |
| `tracking/[token]/sse/route.ts` | ✅ | Public — uses `resolveTrackingToken` |
| `tracking/[token]/documents/route.ts` | ✅ | Public — uses `resolveTrackingToken` |
| `tracking/positions/route.ts` | ✅ | Authed — tenant-scoped GPS positions |
| `tracking/checkcall/route.ts` | ✅ | Authed — record check call |

### quotes/* (5 routes)
| Route | Status | Notes |
|---|---|---|
| `quotes/route.ts` | ✅ | GET + POST |
| `quotes/[id]/route.ts` | ✅ | GET + PATCH |
| `quotes/[id]/book/route.ts` | ✅ | Convert quote → load |
| `quotes/[id]/feedback/route.ts` | ✅ | Win/loss feedback |
| `quotes/analytics/route.ts` | ✅ | Quote stats |

### rates/* + rate/* (3 routes)
| Route | Status | Notes |
|---|---|---|
| `rates/route.ts` | ✅ | Rate snapshots |
| `rates/import/route.ts` | ✅ | Bulk rate import |
| `rate/[token]/route.ts` | 🅿 | Public rating submission |

### matching/* (1 route)
| Route | Status | Notes |
|---|---|---|
| `matching/refresh-lanes/route.ts` | ✅ | Lane recompute |

### loadboard/* + loadboard-sources/* (4 routes)
| Route | Status | Notes |
|---|---|---|
| `loadboard/search/route.ts` | ✅ | Search loads |
| `loadboard/import/route.ts` | ✅ | Import from board |
| `loadboard-sources/route.ts` | ⛔ | Engine 2 admin registry — uses `lib/pipeline/db-adapter`, deferred per Engine 2 Rule A |
| `loadboard-sources/[source]/route.ts` | ⛔ | Engine 2 admin registry — deferred per Engine 2 Rule A |

### settings/* + integrations/* + fuel-index/* (4 routes)
| Route | Status | Notes |
|---|---|---|
| `settings/route.ts` | ✅ | Tenant settings |
| `integrations/route.ts` | ✅ | Integrations list |
| `integrations/[id]/test/route.ts` | ✅ | Test integration |
| `fuel-index/route.ts` | ✅ | Fuel index data |

### import/* (3 routes)
| Route | Status | Notes |
|---|---|---|
| `import/template/[type]/route.ts` | 🅿 | Static CSV template, no DB |
| `import/validate/route.ts` | ✅ | CSV validation (DB lookups) |
| `import/execute/route.ts` | ✅ | Bulk insert |

### dispatch/* (2 routes)
| Route | Status | Notes |
|---|---|---|
| `dispatch/briefing/route.ts` | ✅ | Daily briefing |
| `dispatch/calendar/route.ts` | ✅ | Calendar view |

### notes/* (1 route)
| Route | Status | Notes |
|---|---|---|
| `notes/route.ts` | ✅ | Activity notes |

### finance/* (1 route)
| Route | Status | Notes |
|---|---|---|
| `finance/summary/route.ts` | ✅ | Finance summary |

### push/* (1 route)
| Route | Status | Notes |
|---|---|---|
| `push/subscribe/route.ts` | ✅ | Push subscription (note: push_subscriptions table not yet in prod schema) |

### ai/* (2 routes)
| Route | Status | Notes |
|---|---|---|
| `ai/chat/route.ts` | ✅ | AI tools execute SQL — must wrap each tool execution in withTenant |
| `ai/analyze-risk/route.ts` | ✅ | Risk analysis |

### pipeline/* (1 route)
| Route | Status | Notes |
|---|---|---|
| `pipeline/import/route.ts` | ⛔ | Engine 2 path — deferred per Engine 2 Rule A |

### webhooks/* (1 route)
| Route | Status | Notes |
|---|---|---|
| `webhooks/retell-callback/route.ts` | ⛔ | Engine 2 path (lib/pipeline/retell-webhook) — deferred per Engine 2 Rule A |

### cron/* (7 routes — handled in CRON_REFACTOR section)
| Route | Status | Notes |
|---|---|---|
| `cron/exception-detect/route.ts` | ✅ | Uses `forEachActiveTenant` |
| `cron/fmcsa-reverify/route.ts` | ✅ | Uses `forEachActiveTenant` |
| `cron/invoice-alerts/route.ts` | ✅ | Uses `forEachActiveTenant` |
| `cron/shipper-reports/route.ts` | ✅ | Uses `forEachActiveTenant` |
| `cron/pipeline-health/route.ts` | ⛔ | Engine 2 path (`lib/pipeline/db-adapter`, BullMQ workers) — deferred per Engine 2 Rule A |
| `cron/feedback-aggregation/route.ts` | ⛔ | Engine 2 path (`lib/workers/feedback-worker`) — deferred per Engine 2 Rule A |
| `cron/pipeline-scan/route.ts` | ⛔ | Engine 2 scanner (`lib/loadboards/source-registry`, ScannerService) — deferred per Engine 2 Rule A |

## CRON_REFACTOR section

Cron jobs run with no user/tenant context (Vercel cron triggers them with no
JWT). Pattern:

```ts
import { withTenant, asServiceAdmin } from "@/lib/db/tenant-context"

export async function GET(req: NextRequest) {
  // Cron auth (Vercel signs cron requests)
  // ...

  // 1. Fetch the active tenant list as service_admin
  const tenants = await asServiceAdmin(
    "cron:exception-detect:list-active-tenants",
    async (client) => {
      const { rows } = await client.query<{ id: number; slug: string }>(
        `SELECT id, slug FROM tenants WHERE status = 'active' AND id > 1`,
      )
      return rows
    },
  )

  // 2. Run the cron logic per tenant under withTenant
  const results = []
  for (const tenant of tenants) {
    try {
      const result = await withTenant(tenant.id, async (client) => {
        // ... existing per-tenant logic, parameterized ...
      })
      results.push({ tenant: tenant.slug, ok: true, ...result })
    } catch (err) {
      results.push({ tenant: tenant.slug, ok: false, error: String(err) })
    }
  }
  return NextResponse.json({ ran_at: new Date().toISOString(), results })
}
```

## Stats — final (Session 3 close, 2026-05-04)

| Bucket | Count |
|---|---|
| Total routes catalogued | 88 |
| ✅ Converted to `withTenant` / `requireTenantContext` | 71 |
| ✅ Cron handlers refactored to `forEachActiveTenant` | 4 |
| 🅿 Pre-tenant (no conversion needed) | 7 |
| ⛔ Deferred per Engine 2 Rule A | 6 |
| ⬜ Remaining | 0 |

**Engine 2 deferrals (6):** `loadboard-sources/route.ts`, `loadboard-sources/[source]/route.ts`,
`pipeline/import/route.ts`, `webhooks/retell-callback/route.ts`, `cron/pipeline-health/route.ts`,
`cron/feedback-aggregation/route.ts`, `cron/pipeline-scan/route.ts` (these all live on the
`lib/pipeline/*` / `lib/workers/*` / BullMQ path and will be migrated when migration 030 lands
and pipelines plumb per-load `tenant_id`).

## Session 4 additions (admin onboarding API)

These routes are NEW — they did not exist in the original 88-route catalog
because they didn't need converting. They are listed here as the
canonical inventory of the `/api/admin/**` surface introduced for
Phase 3 (Tenant onboarding system).

| Route | Method | Purpose |
|---|---|---|
| `app/api/admin/config/route.ts` | GET | List tenant config (encrypted values masked) |
| `app/api/admin/config/[key]/route.ts` | PATCH | Update single config key with Zod validation + audit |
| `app/api/admin/tenants/route.ts` | GET / POST | List all tenants (super-admin) / create tenant |
| `app/api/admin/tenants/[id]/route.ts` | GET / PATCH / DELETE | Tenant CRUD (DELETE = soft) |
| `app/api/admin/tenants/[id]/onboard/route.ts` | POST | Idempotent provisioning: clone defaults, seat owner |
| `app/api/admin/tenants/[id]/users/route.ts` | GET / POST | List members / invite by email |
| `app/api/admin/tenants/[id]/purge/route.ts` | POST / DELETE | Schedule 24h-delayed hard delete / cancel pending |
| `app/api/admin/tenants/[id]/export/route.ts` | POST | Build JSON dump of tenant data, upload to Blob |

Routes touched in Session 4 (existing but updated):

| Route | Change |
|---|---|
| `app/api/documents/upload/route.ts` | Switched to tenant-prefixed Blob keys via `tenantBlobKey()` |
| `app/api/loads/[id]/pod/route.ts` | Switched POD upload path to `tenants/{id}/pods/{...}` |

## Helpers introduced this session

- `lib/auth.ts` — `getTenantContext`, `requireTenantContext`, `LEGACY_DEFAULT_TENANT_ID = 2`,
  `JwtPayload` extended with `tenantId` / `tenantIds` / `isSuperAdmin`, legacy-token backfill
  via `backfillTenantClaims`.
- `lib/db/tenant-context.ts` — `withTenant`, `asServiceAdmin`, `resolveTrackingToken`,
  **`forEachActiveTenant(reason, callback)`** (new — drives multi-tenant cron iteration with
  per-tenant fail-soft error capture).

## Cross-tenant escapes (audited)

| Site | Why | Helper used |
|---|---|---|
| `auth/invite POST` — email uniqueness check | New invites must not collide with any existing user across all tenants | `asServiceAdmin("Cross-tenant email uniqueness check for new invite", …)` |
| `tracking/[token]/**` — token → tenant resolution | Public tracking URLs carry no JWT/cookie | `resolveTrackingToken(token)` (built-in audit log) |
| `rate/[token]/route.ts` — public rating page | Rating tokens are independent of tracking_tokens; cross-tenant lookup needed | `asServiceAdmin("Cross-tenant rate token lookup", …)` |
| All 4 refactored crons — enumerate tenants | No JWT context on cron firings | `forEachActiveTenant` (uses `asServiceAdmin` internally for the tenant list query) |

## Pre-existing security fix (out of scope but applied)

`shippers/[id]/route.ts` PATCH had a SQL injection vulnerability: the column name in the
`SET <col> = $1` clause was derived from a regex of user-supplied keys. Closed by adding an
`ALLOWED_COLUMNS` whitelist mapping camelCase request keys to known snake_case column names.
