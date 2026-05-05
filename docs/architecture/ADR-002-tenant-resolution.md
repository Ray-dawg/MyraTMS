# ADR-002 — Tenant Resolution Strategy

| | |
|---|---|
| **Status** | **Approved 2026-05-01** (Patrice resolution round 2) |
| **Date** | 2026-05-01 |
| **Deciders** | Patrice Penda |
| **Drafter** | Claude (Opus 4.7) |
| **Depends on** | [ADR-001](./ADR-001-tenant-isolation.md) |
| **Companion docs** | [PERMISSIONS_MATRIX.md](./PERMISSIONS_MATRIX.md) (role-permission grid), [SECURITY.md](./SECURITY.md) §3 (resolution security) |

## Context

Per ADR-001, every database query runs inside `withTenant(tenantId, callback)`. Before that wrapper can be invoked, the request handler must know **which tenant this request is for**. This is a non-trivial problem in a system that serves four distinct request shapes:

1. **Authenticated browser session.** A broker/admin logs in via `/login`, receives an httpOnly JWT cookie, and navigates the TMS UI.
2. **Authenticated API request from a sibling app.** DApp (driver PWA on `myra-driver-app.vercel.app`) sends `Authorization: Bearer <jwt>` to MyraTMS API. Public tracker (`v0-enterprise-logistic-one-pager.vercel.app`) sends unauthenticated requests with a tracking token in the URL.
3. **Public unauthenticated request.** External shippers click a tracking link (`/track/{token}`), or anonymous users hit the login page (which must render with the right tenant's branding).
4. **Service-to-service call.** Cron jobs, BullMQ workers, scheduled tasks — no user, no browser, no subdomain. These need a separate auth model.

The mega-prompt prescribes:
- Subdomain-based primary (`acme.myraos.ca`)
- Header fallback `X-Tenant-Slug` for service-to-service
- JWT-embedded `tenant_id` for authenticated user sessions
- "Subdomain wins for browser sessions, JWT wins for authenticated API calls, header is service-to-service only"

This ADR codifies that direction, adapts it to the four real request shapes, and resolves the conflict cases.

## Decision

### Resolution precedence (highest wins)

| Priority | Source | Used by | Notes |
|---|---|---|---|
| 1 | **JWT `tenantId` claim** | All authenticated API routes (broker UI, DApp, internal services) | Cryptographically trusted (HMAC-SHA256 verified by middleware). Defends against subdomain spoofing. |
| 2 | **Service-to-service header** `X-Tenant-Id` AND `Authorization: Service <token>` (where token is verified via service JWT with `role: 'service_admin'` claim) | Cron jobs that iterate tenants, BullMQ workers, internal admin scripts | Header alone is NOT trusted. Requires a separately-issued service JWT. |
| 3 | **Tracking token resolution** | `/api/tracking/[token]/*`, `/track/[token]`, `/api/rate/[token]` | Token lookup in `tracking_tokens`/`delivery_ratings` yields `tenant_id` of the parent load/shipper. Bypasses subdomain. |
| 4 | **Subdomain** (`acme.myraos.ca` → `tenants.slug = 'acme'`) | Unauthenticated browser sessions (login page, marketing previews); also used to render tenant-branded chrome BEFORE login completes | Lowest priority because spoofable. Used only when no higher-priority source exists. |
| 5 | **Reject** | All other requests | HTTP 400 `{ error: "Tenant not resolved" }` |

### Conflict cases (must reject 403)

If JWT `tenantId` ≠ subdomain-resolved tenant ID, **reject 403** and log to `tenant_audit_log` with `event_type = 'tenant_resolution_conflict'`. This is a tenant-spoofing signal — either a copy-pasted URL between tenants or an attempted hijack.

Exception: `super_admin` users (those with `tenant_users.role = 'admin'` AND a row for the system tenant `_system`) may legitimately operate across subdomains — they navigate to `acme.myraos.ca/admin/super-admin` to administer Acme's tenant. For these users, JWT carries `tenantIds: number[]` (multi-tenant membership) and the resolved tenant comes from the subdomain, not the JWT primary. Documented edge case; enforced via a `super_admin` flag on the JWT payload.

### Per-request-shape walk-through

#### Shape 1 — Authenticated browser session (broker/admin UI)

```
Request: GET acme.myraos.ca/loads
Cookie: auth-token=<jwt with tenantId:5, tenantIds:[5]>

middleware.ts:
  1. Verify JWT signature (existing verifyJwtEdge).
  2. Resolve subdomain → tenant.id = 5 (acme).
  3. Compare: jwt.tenantId === subdomainTenant.id ? OK : reject 403.
  4. Set req.tenant = { id:5, slug:'acme', type:'saas_customer', subscriptionTier:'pro', features:[...] }
  5. continue()

API route handler:
  await withTenant(req.tenant.id, async (tx) => {
    const loads = await tx.sql`SELECT * FROM loads ORDER BY created_at DESC LIMIT 50`;
    return NextResponse.json(loads);
  })
```

#### Shape 2 — Authenticated API from sibling app (DApp)

```
Request: POST myra-driver-app.vercel.app/api/loads/LD-123/location
  → proxied to MyraTMS via DApp's next.config.mjs rewrite
Authorization: Bearer <driver jwt with tenantId:5, role:'driver', carrierId:'CAR-...'>

middleware.ts:
  1. No subdomain (DApp is on its own domain).
  2. Verify JWT → tenantId:5
  3. Resolution = JWT (priority 1).
  4. Set req.tenant.
```

#### Shape 3 — Public tracking page (external shipper)

```
Request: GET v0-enterprise-logistic-one-pager.vercel.app/track/<64-char-hex-token>
  → proxied to MyraTMS via NEXT_PUBLIC_API_URL

middleware.ts:
  1. Path matches /api/tracking/[token]/* → bypass cookie auth (existing behavior).
  2. Token resolution: SELECT tenant_id FROM tracking_tokens WHERE token = $1 (this query
     runs as service_admin because there's no tenant context yet — chicken-and-egg).
  3. Set req.tenant from the resolved load's tenant_id.
  4. Continue with full RLS scope for that tenant.
```

This is the **chicken-and-egg case**: we need tenant context to query, but we query to discover the tenant. Resolution: a single dedicated function `resolveTrackingToken(token)` in `lib/db/tenant-context.ts` that runs `asServiceAdmin('tracking_token_resolution', tx => ...)` to perform the lookup. The function is the **only** place service-admin escalation happens automatically (no human in the loop). Documented in audit log every call. Phase 1.4 deliverable.

#### Shape 4 — Service-to-service (cron, worker)

```
Cron job: POST /api/cron/invoice-alerts (Vercel cron)
Authorization: Bearer <CRON_SECRET as a service JWT>
X-Tenant-Id: 5  (set by the cron iterator)

middleware.ts:
  1. Verify service JWT signature → role:'service_admin'
  2. Read X-Tenant-Id header → 5
  3. Set req.tenant.id = 5, req.tenant.role = 'service_admin'

Cron route iterates: for each active tenant, dispatch a sub-request OR loop in-process with withTenant().
```

For Vercel cron specifically: a single cron entry hits `/api/cron/invoice-alerts` (no tenant header) — the route reads all active tenants and loops `for (tenant of activeTenants) { await withTenant(tenant.id, ...) }`. The header pattern is reserved for internal services that target a specific tenant.

#### Shape 5 — Driver PIN login (special case)

```
Request: POST /api/auth/driver-login
Body: { carrier_code: 'ABC123', pin: '1234' }

Route handler (no tenant context yet):
  1. asServiceAdmin('driver_login', async tx => {
       const carrier = await tx.sql`SELECT id, tenant_id FROM carriers WHERE code = ${code}`;
       if (!carrier) return 404;
       const driver = await tx.sql`SELECT * FROM drivers WHERE carrier_id = ${carrier.id} AND app_pin = ${pin}`;
       ...
       return createToken({ ..., tenantId: carrier.tenant_id, role: 'driver' });
     })
```

The driver's tenant context is implicit in their carrier. JWT issued carries `tenantId`. All subsequent driver requests use Shape 2.

#### Shape 6 — Login page (anonymous, pre-auth)

```
Request: GET acme.myraos.ca/login

middleware.ts:
  1. /login is a public path (existing).
  2. Resolve subdomain → tenant.id = 5.
  3. Set req.tenant for chrome-rendering only (logo, colors, name).
  4. POST /api/auth/login uses the subdomain-derived tenant for the lookup:
       SELECT * FROM users
       JOIN tenant_users ON users.id = tenant_users.user_id
       WHERE users.email = $email AND tenant_users.tenant_id = $subdomainTenant
```

If the user exists in multiple tenants, the login response includes `tenantOptions: [{id, slug, name}]` and the UI renders a tenant picker. Once selected, JWT issued carries the chosen `tenantId`.

### JWT shape changes

Today's `JwtPayload` (in `lib/auth.ts`):
```ts
{ userId, email, role, firstName, lastName, carrierId? }
```

After Phase 2.3:
```ts
{
  userId, email, role, firstName, lastName, carrierId?,
  tenantId: number,           // primary/active tenant
  tenantIds: number[],        // all tenants this user belongs to
  isSuperAdmin?: boolean,     // can cross subdomains; rare
}
```

`role` values are constrained to the 6-role enum from [PERMISSIONS_MATRIX.md](./PERMISSIONS_MATRIX.md): `owner | admin | operator | driver | viewer | service_admin`. Per Patrice resolution Q2, `owner`/`admin`/`operator`/`service_admin` are enforced in Phase 1; `driver`/`viewer` scaffolded.

The `verifyJwtEdge()` Edge-runtime verifier in `middleware.ts` is updated in lockstep. No structural change — the payload fields are added; the HMAC verification logic is unchanged.

### Subdomain resolution

DNS configuration:
- `*.myraos.ca` → CNAME → MyraTMS Vercel deployment
- `myraos.ca` → MyraTMS marketing site OR redirect to `app.myraos.ca`
- Custom domains for whitelabel (Phase 5.3): `app.acme.com` → CNAME → MyraTMS Vercel; tenant has a row in `tenant_config` keyed by hostname

Middleware extraction logic:
```ts
const host = request.headers.get('host') || '';
// strip port
const hostname = host.split(':')[0];
// reject host header injection — only allow letters/digits/dots/hyphens
if (!/^[a-z0-9.-]+$/i.test(hostname)) return reject400;
const subdomain = hostname.split('.')[0];
// special subdomains — resolve from JWT only
if (['app', 'www', 'myraos', 'admin', 'api'].includes(subdomain)) return null;
// real tenant slugs match the registration regex
if (!/^[a-z][a-z0-9-]{2,30}$/.test(subdomain)) return null;
const tenant = await lookupTenantBySlug(subdomain);
```

Slug regex `^[a-z][a-z0-9-]{2,30}$` (per Patrice Q3 resolution): leading lowercase letter, then lowercase alphanumerics + hyphens, length 3–31. Disallows leading underscore (reserved for `_system` tenant), leading numerics, and uppercase. Same regex enforced at tenant creation time in `lib/tenants/validators.ts`.

Hostname validation prevents Host-header injection (a tenant claiming to be `'acme; --'.myraos.ca`). Phase 7.3 security audit task.

## Consequences

### Positive

- **JWT-first precedence.** Cryptographically trusted source wins. URL manipulation cannot escalate.
- **Per-request-shape clarity.** Each of the six shapes has a documented resolution path. No surprise resolution in Phase 2.4 refactor.
- **Tracking token bypass is explicit.** The one place where service-admin escalation happens automatically (token resolution) is named and audited.
- **Driver flow preserved.** PIN login continues to work; tenant context derives from carrier.
- **Backwards-compatible JWT.** Existing tokens without `tenantId` claim default to tenant 1 in Phase 2.3 (per ADR-004 backwards-compat strategy), then the requirement tightens.

### Negative

- **Tenant-resolution conflicts must be rejected, not auto-resolved.** This is a UX papercut: a Tenant 1 admin who pastes a Tenant 5 URL hits a 403 instead of a friendly redirect. Mitigation: in the 403 page, if the user belongs to the requested tenant, offer a "Switch to Tenant Acme" button.
- **Subdomain spoofing surface.** Custom domains (Phase 5.3) require careful Host-header validation. Phase 7.3 security audit explicitly checks this.
- **One service-admin auto-escalation path** (tracking token resolution) is necessary but creates a nonzero risk of misuse. Mitigated by: auditing every call, failing closed if the token doesn't exist, and limiting the function's scope to the single SELECT.
- **Driver login depends on carrier-tenant linkage.** A carrier without a `tenant_id` (legacy data) breaks driver login until backfilled. Phase 1.2 backfill defaults to tenant 1.

### Neutral

- The `super_admin` flag in JWT is an explicit role rather than a special tenant. This avoids the ambiguity of "tenant 0 = system tenant means super-admin" — instead, a user can be `super_admin: true` regardless of tenant_users membership (granted only by another super-admin via direct DB write or a Phase 5.5 super-admin UI).

## Alternatives considered

### Pure subdomain (no JWT tenant claim)

**Rejected.** Forces every request to do a DNS-style lookup at middleware time. Spoofable by Host header (mitigated but never zero risk). And: cannot distinguish between "I'm authed for tenant 5 visiting tenant 5's subdomain" and "I'm authed for tenant 5 visiting tenant 7's subdomain by URL paste" — both look identical to subdomain-only resolution.

### Pure JWT (no subdomain)

**Rejected.** Breaks unauthenticated flows (login page rendering, marketing landing). Forces `app.myraos.ca` for everyone, which kills the whitelabel branding value-prop (Phase 5.3).

### Path-prefix routing (`/t/{tenantSlug}/...`)

**Rejected.** Uglier URLs, breaks shareable shipper-tracking links, requires every Next.js route to live under `[tenantSlug]/...` segments — massive refactor for marginal gain over subdomain.

### Cookie-based selection (last-used tenant in cookie)

**Rejected as primary.** Cookies are per-domain — a user with multiple tenants on the same root domain would have a single cookie that confuses the resolution. JWT claim is the cleaner mechanism.

## Out-of-scope decisions deferred

- **Custom domain HTTPS provisioning** (Let's Encrypt automation for `app.acme.com`). Phase 5.3 deliverable.
- **Tenant slug reservation list** (forbidden slugs: `app`, `www`, `admin`, `api`, etc.). Codified in `lib/tenants/reserved-slugs.ts` in Phase 3.1.
- **Whitelabel domain → tenant_id mapping.** Stored in `tenant_config` with key `custom_domain`. Lookup happens before subdomain resolution if `host !== '*.myraos.ca'`. Phase 5.3.

## Validation

This ADR is satisfied when:
1. Phase 2.1 `middleware.ts` implements the precedence order with all 6 shapes covered.
2. Phase 2.3 JWT payload includes `tenantId`, `tenantIds`, optional `isSuperAdmin`.
3. Phase 7.3 security audit confirms: (a) JWT-subdomain conflict rejects 403 + audits, (b) Host-header injection rejected, (c) tracking-token resolution audits every call, (d) driver login carries correct tenant.
4. Phase 1.6 integration test scenarios 6 (subdomain routing under load) passes.
