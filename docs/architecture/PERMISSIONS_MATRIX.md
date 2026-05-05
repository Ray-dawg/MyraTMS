# PERMISSIONS_MATRIX.md

> **Cadence:** Updated when roles or capabilities change.
> **Last update:** 2026-05-01 (Session 1, Phase 0)
> **Related:** [ADR-002](./ADR-002-tenant-resolution.md), [ADR-003](./ADR-003-feature-gating.md), [SECURITY.md](./SECURITY.md)

This document is the source of truth for the role-permission matrix. Phase 2 RBAC enforcement reads from this directly.

## §1 — Roles

Six roles defined in the `tenant_users.role` enum (Phase 1 migration 027):

| Role | Scope | Description |
|---|---|---|
| `owner` | One tenant | Top-level tenant admin. Can delete the tenant, manage billing, transfer ownership. **One owner per tenant minimum.** |
| `admin` | One tenant | Tenant admin. Manages users + config + integrations. Cannot delete tenant or change billing. |
| `operator` | One tenant | Daily ops user — dispatch, customer success, finance ops. Cannot manage users or config. |
| `driver` | One tenant | Driver mobile app access only. Very narrow scope (own loads + own profile). |
| `viewer` | One tenant | Read-only across the tenant. For auditors, investors, advisors. |
| `service_admin` | All tenants | Myra cross-tenant support staff. **RESERVED** — only assignable from the super-admin dashboard. Audited per [SECURITY.md](./SECURITY.md) §4. |

### Implementation status (Phase 1)

Per Patrice's resolution: only `owner`, `admin`, `operator`, `service_admin` get fully wired permission checks in Phase 1. `driver` and `viewer` get scaffolded permission stubs; full RBAC enforcement deferred to a later session.

| Role | Phase 1 status | Full enforcement session |
|---|---|---|
| `owner` | **Full** | Phase 1 |
| `admin` | **Full** | Phase 1 |
| `operator` | **Full** | Phase 1 |
| `service_admin` | **Full** | Phase 1 |
| `driver` | Scaffolded (existing driver-route allowlist in `middleware.ts` continues to enforce) | Future session — alignment with `operator` permissions then driver-narrow restrictions |
| `viewer` | Scaffolded (`requireRole(user, 'viewer', 'operator', 'admin', 'owner')` for read-only routes; viewer cannot mutate) | Future session — full read enforcement across all UI surfaces |

## §2 — Role hierarchy

`service_admin > owner > admin > operator > viewer`

`driver` is parallel — narrow scope, not part of the strict hierarchy. A driver in tenant 5 cannot escalate to operator in tenant 5.

Implementation: `requireRole(user, ...allowedRoles)` in `lib/auth.ts` does an explicit allowlist check (no implicit "higher role grants lower permissions" magic). Each route's allowed roles are listed explicitly.

## §3 — Capability matrix

Rows = capabilities. Columns = roles. ✅ = allowed. ❌ = denied. **🔒** = service_admin-only (cross-tenant). 🟡 = scaffolded (deferred).

### §3.1 — Tenant management

| Capability | owner | admin | operator | driver | viewer | service_admin |
|---|---|---|---|---|---|---|
| Create new tenant | ❌ | ❌ | ❌ | ❌ | ❌ | 🔒 |
| Delete own tenant | ✅ | ❌ | ❌ | ❌ | ❌ | 🔒 |
| Suspend own tenant | ✅ | ❌ | ❌ | ❌ | ❌ | 🔒 |
| Update tenant name / branding | ✅ | ✅ | ❌ | ❌ | ❌ | 🔒 |
| View tenant settings | ✅ | ✅ | ✅ | ❌ | 🟡 | 🔒 |
| Export tenant data (GDPR) | ✅ | ✅ | ❌ | ❌ | ❌ | 🔒 |
| Purge tenant data (right to delete) | ✅ | ❌ | ❌ | ❌ | ❌ | 🔒 |

### §3.2 — User management within tenant

| Capability | owner | admin | operator | driver | viewer | service_admin |
|---|---|---|---|---|---|---|
| Invite user | ✅ | ✅ | ❌ | ❌ | ❌ | 🔒 |
| Change user role | ✅ | ✅ (except cannot promote to owner) | ❌ | ❌ | ❌ | 🔒 |
| Promote to owner | ✅ | ❌ | ❌ | ❌ | ❌ | 🔒 |
| Remove user | ✅ | ✅ (except owner) | ❌ | ❌ | ❌ | 🔒 |
| List users in tenant | ✅ | ✅ | ✅ | ❌ | 🟡 | 🔒 |
| Assign `service_admin` role | ❌ | ❌ | ❌ | ❌ | ❌ | 🔒 (super-admin dashboard only) |

### §3.3 — Billing & subscription

| Capability | owner | admin | operator | driver | viewer | service_admin |
|---|---|---|---|---|---|---|
| View invoices | ✅ | ✅ | ❌ | ❌ | ❌ | 🔒 |
| Update payment method | ✅ | ❌ | ❌ | ❌ | ❌ | 🔒 |
| Upgrade / downgrade tier | ✅ | ❌ | ❌ | ❌ | ❌ | 🔒 |
| Cancel subscription | ✅ | ❌ | ❌ | ❌ | ❌ | 🔒 |
| View usage metrics | ✅ | ✅ | ✅ | ❌ | 🟡 | 🔒 |

> Billing capabilities are scaffolded only in Phase 1. Full Stripe integration is deferred per [BILLING_DEFERRED.md](./BILLING_DEFERRED.md).

### §3.4 — Integrations & credentials

| Capability | owner | admin | operator | driver | viewer | service_admin |
|---|---|---|---|---|---|---|
| Add / update integration credential | ✅ | ✅ | ❌ | ❌ | ❌ | 🔒 |
| View integration list (no credentials) | ✅ | ✅ | ✅ | ❌ | 🟡 | 🔒 |
| **Reveal** decrypted credential | ❌ | ❌ | ❌ | ❌ | ❌ | 🔒 (with explicit reason logged) |
| Test integration connection | ✅ | ✅ | ❌ | ❌ | ❌ | 🔒 |
| Delete integration | ✅ | ✅ | ❌ | ❌ | ❌ | 🔒 |

> Decrypted credentials are NEVER returned to UI. Even owner/admin sees the credential in masked form (last 4 chars). Service-admin reveal is for incident response only.

### §3.5 — Operational data (loads, carriers, shippers, invoices)

| Capability | owner | admin | operator | driver | viewer | service_admin |
|---|---|---|---|---|---|---|
| Create / update / delete loads | ✅ | ✅ | ✅ | ❌ | ❌ | 🔒 |
| View own loads (driver) | — | — | — | ✅ | — | — |
| Update load status (driver: own load only) | — | — | — | ✅ | — | — |
| Upload POD (driver: own load only) | — | — | — | ✅ | — | — |
| Create / update / delete carriers | ✅ | ✅ | ✅ | ❌ | ❌ | 🔒 |
| Create / update / delete shippers | ✅ | ✅ | ✅ | ❌ | ❌ | 🔒 |
| Create / update / delete invoices | ✅ | ✅ | ✅ | ❌ | ❌ | 🔒 |
| Read all of the above | ✅ | ✅ | ✅ | ❌ (driver: own only) | 🟡 | 🔒 |
| Bulk import (CSV) | ✅ | ✅ | ✅ | ❌ | ❌ | 🔒 |

### §3.6 — Workflows & automation

| Capability | owner | admin | operator | driver | viewer | service_admin |
|---|---|---|---|---|---|---|
| Create / update / delete workflows | ✅ | ✅ | ❌ | ❌ | ❌ | 🔒 |
| View workflows | ✅ | ✅ | ✅ | ❌ | 🟡 | 🔒 |
| Trigger workflow manually | ✅ | ✅ | ✅ | ❌ | ❌ | 🔒 |

### §3.7 — Engine 2 (when active per Phase M5)

| Capability | owner | admin | operator | driver | viewer | service_admin |
|---|---|---|---|---|---|---|
| View AutoBroker pipeline state | ✅ | ✅ | ✅ | ❌ | 🟡 | 🔒 |
| Update tenant personas | ✅ | ✅ | ❌ | ❌ | ❌ | 🔒 |
| Trigger manual scan | ✅ | ✅ | ❌ | ❌ | ❌ | 🔒 |
| Manage DNC list | ✅ | ✅ | ✅ | ❌ | ❌ | 🔒 |
| View call recordings | ✅ | ✅ | ✅ | ❌ | 🟡 | 🔒 |
| Manage Retell agent IDs | ✅ | ✅ | ❌ | ❌ | ❌ | 🔒 |

### §3.8 — Cross-tenant operations (service_admin only)

| Capability | service_admin |
|---|---|
| List all tenants | 🔒 |
| View any tenant's data | 🔒 (with reason logged per [SECURITY.md](./SECURITY.md) §4) |
| Provision new tenant | 🔒 |
| Suspend any tenant | 🔒 |
| Hard-delete (purge) any tenant | 🔒 (24-hour delay + double confirmation per Phase 3.5) |
| Cross-tenant analytics queries | 🔒 |
| Run data backfills | 🔒 |
| Override feature flags | 🔒 |
| Override usage limits | 🔒 |

## §4 — Implementation pattern

API routes use `requireRole()` from `lib/auth.ts`. Phase 2.4 refactor:

```ts
// Example: PATCH /api/loads/[id] — operator+ can update
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(request);
  if (!user) return apiError('Unauthorized', 401);
  const denied = requireRole(user, 'owner', 'admin', 'operator');
  if (denied) return denied;
  const { id } = await params;
  return await withTenant(user.tenantId, async (tx) => {
    // …
  });
}
```

For multi-step operations (e.g., billing upgrade requires both owner role AND `tier-change` feature override), enforce both:

```ts
const denied = requireRole(user, 'owner');
if (denied) return denied;
requireFeature(req.tenant, 'tier_change_self_serve');  // optional gate
```

## §5 — Driver permission narrowing (deferred)

Driver routes today are guarded by an allowlist in `MyraTMS/middleware.ts`:

```
const driverAllowed = [
  '/api/drivers/me',
  '/api/loads/',           // Own load via IDOR check in handler
  '/api/auth/logout',
  '/api/auth/me',
];
```

Phase 2.4 retains this allowlist but adds:
- Driver JWT carries `tenantId` and `driverId` (not just `userId`)
- All driver routes use `withTenant(jwt.tenantId, ...)` so a driver from tenant 5 cannot accidentally read tenant 7 loads even via IDOR (RLS catches it)
- Driver IDOR check on `/api/loads/[id]/*` continues to verify the load belongs to the driver

Full driver-permission session (future) will:
- Define narrower capability set (no carrier read, no shipper read, no invoice read except own load's invoice)
- Audit every driver-route handler for excessive data exposure
- Add per-route driver permission tests

## §6 — Viewer permission scaffolding

Viewers are read-only. Phase 1 implementation:

- `requireRole(user, 'owner', 'admin', 'operator', 'viewer')` on all GET routes
- All POST/PATCH/PUT/DELETE routes exclude viewer
- Viewer JWT identical structure to other roles, just `role:'viewer'`
- UI Phase 5.4 will hide write actions for viewers (cosmetic per ADR-003)

Future viewer session will:
- Audit GET routes for any data viewer shouldn't see (e.g., raw integration credentials, audit log entries created by other users)
- Define viewer-specific list filters (maybe viewers only see closed loads, not in-flight)
- Add per-route viewer access tests

## §7 — Role assignment audit trail

Every role change writes to `tenant_audit_log`:
- `event_type = 'tenant_user_role_changed'`
- `event_payload = { target_user_id, old_role, new_role }`

This includes:
- Tenant admin promoting an operator to admin
- Owner transferring ownership
- Service-admin force-changing a role for compliance
- Removing a user (logged as role change to NULL)

Read access: tenant admins see their own tenant's role changes; service_admin sees all.

End of PERMISSIONS_MATRIX.md.
