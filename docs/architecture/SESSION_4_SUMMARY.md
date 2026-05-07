# SESSION_4_SUMMARY.md

> **Session:** 4 — Phase 3 (Tenant onboarding system, backend)
> **Started / closed:** 2026-05-05
> **Status:** ✅ COMPLETE — production typechecks clean, 275/280 tests pass (5 pre-existing Engine 2 cost-calculator failures unrelated to multi-tenancy)
> **Drafter:** Claude (Opus 4.7) under Patrice direction

## TL;DR

The platform now has the API surface to manage tenants from outside the
database. A super-admin can create a tenant, invite its owner, run the
onboarding bootstrap (which clones default config), update the tenant
record, list and invite users, take a JSON export, soft-delete it, and
schedule a 24-hour-delayed hard purge with double-confirmation. All
config edits flow through Zod validation per key with audit logging,
and credentials are encrypted server-side and masked on read.

What is NOT in this session: the cron that actually executes scheduled
purges (storage exists, executor is documented as a follow-up), the
zip-with-blob-attachments export (current export is JSON-only), and the
admin UI itself (Phase 5 territory).

## §1 — Deliverables produced

### New library modules (in `MyraTMS/lib/`)

| File | Purpose |
|---|---|
| `lib/tenants/config-schema.ts` | Per-key Zod validators for every entry in DEFAULT_TENANT_CONFIG and SENSITIVE_CONFIG_KEYS. Module-load guard throws if a new default key is added without a validator. Helpers: `validateConfigValue(key, value)`, `isKnownConfigKey(key)`, `isEncryptedConfigKey(key)`. |
| `lib/blob/tenant-paths.ts` | Tenant-namespaced Vercel Blob keys: `tenants/{tenantId}/{kind}/{filename}` with `kind ∈ {documents, pods, exports, branding}`. Path-traversal sanitization, prefix helpers for list/delete, `parseTenantBlobKey` for legacy detection. |

### `lib/auth.ts` additions

| Helper | Purpose |
|---|---|
| `requireSuperAdmin(request)` | Returns 401 / 403 Response or null. Used as the gate for every `/api/admin/**` route before any DB call (so unauthorized callers never hit `asServiceAdmin` and don't show up in the audit log). |

### New API surface (in `MyraTMS/app/api/admin/`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/config` | List every config row for the caller's tenant. Encrypted values decrypted server-side, masked, and returned with `encrypted: true`. |
| PATCH | `/api/admin/config/[key]` | Validate via Zod, encrypt if `isEncryptedConfigKey(key)`, upsert, audit-log with masked old/new values. |
| GET | `/api/admin/tenants` | Super-admin only. Lists every active tenant with user/load counts. |
| POST | `/api/admin/tenants` | Super-admin only. Creates a tenant row; provisioning happens in `/onboard`. Slug validated against regex + reserved list. |
| GET | `/api/admin/tenants/[id]` | Super-admin only. Returns full tenant + counts. |
| PATCH | `/api/admin/tenants/[id]` | Super-admin only. Updates name/status/billingEmail/parent/primaryAdmin. Slug + type immutable. |
| DELETE | `/api/admin/tenants/[id]` | Super-admin only. Soft delete (sets `deleted_at`, status='canceled'). Reason required as query param. Refuses '_system'. |
| POST | `/api/admin/tenants/[id]/onboard` | Super-admin only. Idempotent provisioning: clones DEFAULT_TENANT_CONFIG, applies overrides, seats owner in tenant_users, flips trial→active. |
| GET | `/api/admin/tenants/[id]/users` | Super-admin only. Lists tenant_users members + pending invites. |
| POST | `/api/admin/tenants/[id]/users` | Super-admin only. Creates a tenant-scoped invite + sends email. Cross-tenant uniqueness checked; reuses existing user record if email already on the platform. |
| POST | `/api/admin/tenants/[id]/purge` | Super-admin only. Schedules a 24h-delayed hard delete. Tenant must be soft-deleted first; body must echo the slug verbatim; reason required (≥20 chars). Tracked in `tenant_audit_log` only — no separate purge table. |
| DELETE | `/api/admin/tenants/[id]/purge` | Super-admin only. Cancels a pending purge. Idempotent (200 even if nothing pending). |
| POST | `/api/admin/tenants/[id]/export` | Super-admin only. Builds a JSON dump of all tenant tables and uploads to `tenants/{id}/exports/{exportId}.json`. Manifest includes table counts and schema_version. |

### Updated API routes

| File | Change |
|---|---|
| `app/api/documents/upload/route.ts` | Switched from flat `myra-tms/{type}/{id}/{name}` keys to `tenants/{id}/documents/{prefixed-name}` via `tenantBlobKey()`. |
| `app/api/loads/[id]/pod/route.ts` | Switched POD upload from `pod/{loadId}/{ts}-{name}` to `tenants/{id}/pods/{loadId-ts-name}`. |

### Tests (in `MyraTMS/__tests__/lib/`)

| File | Coverage |
|---|---|
| `tenants-config-schema.test.ts` | 27 cases — coverage guard (every default + sensitive key has a validator), per-key happy/sad paths for currency, locale, timezone, margins, rate factor, hex color, URL, email, boolean, E.164 phone, opaque credentials, unknown-key rejection. |
| `blob-tenant-paths.test.ts` | 16 cases — happy path, path-traversal sanitization (`..`/slashes/backslashes), input validation (non-positive id, NaN, unknown kind, empty filename), prefix helpers, `parseTenantBlobKey` round-trip + legacy-flat-key returns null. |

## §2 — Architectural decisions surfaced this session

### 2.1 — Audit log as purge-state store

There is no `tenant_pending_purges` table — the latest unresolved
`tenant_purge_scheduled` event in `tenant_audit_log` IS the pending
purge record. Cancellation is a `tenant_purge_cancelled` event;
execution (future cron) will be `tenant_purge_executed`. Querying
"is there a pending purge?" uses an anti-join on later events:

```sql
SELECT (event_payload->>'scheduled_for')
  FROM tenant_audit_log
 WHERE tenant_id = $1
   AND event_type = 'tenant_purge_scheduled'
   AND created_at > NOW() - INTERVAL '7 days'
   AND NOT EXISTS (
     SELECT 1 FROM tenant_audit_log later
      WHERE later.tenant_id = $1
        AND later.created_at > tenant_audit_log.created_at
        AND later.event_type IN ('tenant_purge_cancelled', 'tenant_purge_executed')
   )
 ORDER BY created_at DESC LIMIT 1
```

This avoids an extra migration and keeps the purge state alongside the
rest of the tenant's history. Trade-off: queries are wordier, and a
malicious super-admin could in principle race the executor by injecting
a fake `tenant_purge_cancelled` event — but that requires DB write
access which they already have, so the audit log is no weaker than any
alternative storage.

### 2.2 — Soft-delete-then-purge invariant

The purge endpoint refuses to schedule until the tenant is already
soft-deleted (`deleted_at IS NOT NULL`). Forces a two-step ceremony:
operator first DELETEs (instantly reversible by clearing `deleted_at`),
then explicitly POSTs to `/purge` 24h before the data actually goes
away. The slug-confirmation echo on the purge POST is a third gate
against typo-targeting.

### 2.3 — JSON-only export (zip deferred)

The export route produces a JSON dump of every tenant-scoped table
plus a manifest. It does NOT bundle attachments (PODs, documents)
because that requires either streaming `archiver` to Vercel Blob (the
runtime can timeout) or scheduling a Vercel Workflow. The manifest
includes blob URLs so a downstream consumer can fetch attachments
out-of-band, and the `documents` table rows in the dump carry their
`blob_url` directly.

The full zip-with-attachments export is documented as Phase 3.4.b — a
follow-up session that will add either Vercel Workflow durability or a
chunked streaming uploader.

### 2.4 — `requireSuperAdmin` runs before `asServiceAdmin`

Every admin route checks `requireSuperAdmin(req)` BEFORE invoking
`asServiceAdmin`. Why: `asServiceAdmin` writes a `service_admin_invocation`
audit record on every call, and an unauthorized 401/403 should not
generate a "service admin acted" event in the log. Auth fails at the
route gate; the audit log only records actions that were actually
authorized to attempt.

### 2.5 — Encrypted-config storage shape

For sensitive keys, the route encrypts (via `lib/crypto/tenant-secrets`)
BEFORE the DB write. The DB column `tenant_config.value` is TEXT with
`encrypted=BOOLEAN` — encrypted values are base64-encoded ciphertext,
plaintext values are JSON-encoded. The GET endpoint decrypts then
calls `maskCredential()` so the API never returns plaintext to a
client. Audit log records `<encrypted>` for both old and new values
when `encrypted=true`, so even forensic review of the audit table
cannot reconstruct credentials.

## §3 — What is *not* built yet (deferred)

| Item | Why deferred | Tracked under |
|---|---|---|
| Purge executor cron | Out of scope for "API surface" session — needs its own design (idempotency on retries, partial-failure recovery, post-execute Blob cleanup of `tenants/{id}/`). Should be a follow-up session, paired with the cron health-check pattern from Session 3. | TODO §4.1 |
| Zip-with-attachments export | Needs streaming archiver-to-Blob OR Vercel Workflow durability for big tenants. JSON-only export is the immediate-needs version. | Phase 3.4.b |
| `user_invites.role` enum widening | Current schema only allows `('admin','broker')` — invites for `operator`/`viewer`/`owner` are coerced to admin/broker until migration 022 is updated. | TODO §4.2 |
| Admin UI | Phase 5 territory. Today these are API-only. | Phase 5 |
| Tenant-rename flow (slug change) | Slug change requires subdomain redirect handling. Not part of MVP — slugs are immutable post-creation. | Future |
| Cross-tenant analytics | Querying across tenants for platform-level insight (MRR, usage tiers). Phase 6 deliverable per ADR-001. | Phase 6 |

## §4 — Verification

### Typecheck
```
$ npx tsc --noEmit
(exit 0)
```

### Test suite
```
$ pnpm vitest run
Test Files  1 failed | 20 passed (21)
Tests       5 failed | 275 passed (280)
```

The 5 failures are pre-existing Engine 2 numeric drift in
`lib/pipeline/__tests__/cost-calculator.test.ts`. Net change vs.
Session 3 close: **+43 passing, 0 regressions**.

### Smoke confirmation (still TODO before Phase M3)
- [ ] Create a Tenant 3 via `POST /api/admin/tenants`, onboard via `/onboard`, confirm row in `tenant_users` and 18+ rows in `tenant_config`
- [ ] Invite a user, accept the invite, confirm tenant_users row added
- [ ] PATCH a sensitive config key (e.g. `dat_credentials`), GET back, confirm masked
- [ ] Schedule a purge, confirm 409 on second schedule, cancel, confirm 200
- [ ] Initiate an export, fetch the resulting JSON URL, confirm tenant_id matches in every row

## §5 — Open items for Patrice

| # | Item | Action requested | Blocking? |
|---|---|---|---|
| 1 | `user_invites.role` enum widening | Approve a small follow-up migration to mirror the `tenant_users.role` enum (`owner`, `admin`, `operator`, `viewer`). | Soft — current coercion (operator/viewer → 'broker') works but loses fidelity in audit logs |
| 2 | Purge executor cron design | Decide: separate cron iterating tenants past their `scheduled_for`, vs Vercel Workflow with `sleep`-then-execute. | Not blocking — purge is admin-driven and 24h is a soft SLA |
| 3 | Default JWT for super-admin testing | The auth flow has no UI to flip `isSuperAdmin=true`. For now this requires a direct DB write to `users.is_super_admin` (column added in migration 027) + re-login. | Soft — needed for staging smoke tests |

## §6 — Cumulative scorecard

| Metric | Value |
|---|---|
| Sessions completed | 4 of 8 |
| Cumulative actual time | ~17h (Session 4 ran ~4h vs 4–5h budget) |
| Cumulative budget low | 15h |
| Cumulative budget high | 18h |
| Status | Within tolerance — Session 4 came in mid-band, recovering from Session 3's +25% |
| Blockers | None |
| Open questions for Patrice | 3 (all in §5); none blocking Session 5 start |

## §7 — Session 5 readiness

Session 5 (Phase 4 — Feature gating + subscription tiers, no billing) is
unblocked. The `tenant_config` and feature-gating tables exist, the
admin API to set per-tenant overrides exists. Phase 4 work focuses on:
- Reading the gates at request time (hot-path: `feature_overrides`)
- Wiring middleware/route guards to enforce tier limits
- Usage-tracking instrumentation
- The "trial expired" UX hook

Stripe integration remains deferred per BILLING_DEFERRED.md.

End of Session 4.
