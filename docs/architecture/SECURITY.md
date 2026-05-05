# SECURITY.md

> **Cadence:** Reviewed quarterly; updated whenever an ADR or migration changes the security posture.
> **Last update:** 2026-05-01 (Session 1, Phase 0)
> **Owner:** Patrice Penda

This document is the operational security reference for the multi-tenant MyraTMS platform. It captures crypto choices, key rotation, RLS enforcement, service-admin escalation, and incident response — the cross-cutting concerns that touch multiple ADRs.

## §1 — Encryption at rest for tenant credentials

### Algorithm and library

- **Algorithm:** AES-256-GCM (authenticated encryption)
- **Implementation:** Node `node:crypto` `createCipheriv('aes-256-gcm', key, nonce)` / `createDecipheriv`
- **Library path:** `lib/crypto/tenant-secrets.ts` (created Phase 1.4)
- **Public API:**
  ```ts
  encrypt(plaintext: string): string  // returns base64 of nonce:ct:tag
  decrypt(ciphertext: string): string // throws CryptoDecryptError on tag mismatch
  ```
- **Random nonce per encryption.** 12 bytes (96 bits) from `crypto.randomBytes(12)`. Never reused.
- **Storage format:** base64-encoded `{nonce}:{ciphertext}:{auth_tag}` where the three parts are concatenated with `:` separators after individual base64 encoding. Example: `aGVsbG8=:d29ybGQ=:dGFnMTIz`.
- **Why GCM, not CBC:** GCM provides authenticated encryption — tampering is detected on decrypt rather than silently accepted. CBC requires a separate HMAC for integrity, doubling the failure surface.

### Master key

- **Source:** `MYRA_TENANT_CONFIG_KEY` env var, set in Vercel project settings.
- **Format:** 32-byte (256-bit) random value, base64-encoded for env var transport.
- **Generation:** `openssl rand -base64 32` — ran once at platform inception, stored in 1Password.
- **Rotation cadence:** Every 12 months OR immediately on any suspected compromise.
- **Never:** committed to repo; logged; stored in DB; emailed; pasted to chat.

### What MUST be encrypted (`encrypted=true` in `tenant_config`)

| Key category | Examples |
|---|---|
| Voice agent | Retell API keys, Retell agent IDs (per-tenant) |
| Load boards | DAT credentials, Truckstop credentials, 123Loadboard, Loadlink |
| Payments / Capital | Stripe keys (when stored per-tenant rather than platform-level), Persona API keys |
| Email / SMS | Per-tenant SMTP credentials, Twilio per-tenant subaccount tokens |
| Webhooks | Inbound webhook signing secrets (Stripe, Retell, Persona) |
| Compliance | FMCSA API keys (if per-tenant), Samsara/Motive ELD tokens |
| Other | Any third-party integration token where leakage causes financial or contractual harm |

### What MUST NOT be encrypted (`encrypted=false`)

| Key category | Why plaintext is fine |
|---|---|
| Display preferences | locale, timezone, currency display format |
| Branding | logo URL, primary color hex, secondary color hex, brand name |
| Operational defaults | margin floor, walk-away rate factor, persona α/β init values, default carrier rating thresholds |
| Public identifiers | tenant slug, custom domain, public-facing legal name |

**Rule:** if leaked exposure has zero financial, contractual, or regulatory consequence, encryption adds operational pain without benefit.

### Key rotation procedure

Triggered annually OR on suspected compromise. Documented step-by-step:

1. **Generate new key**: `openssl rand -base64 32` → store in 1Password as `MYRA_TENANT_CONFIG_KEY_v{N+1}`.
2. **Stage in Vercel**: add `MYRA_TENANT_CONFIG_KEY_NEXT` env var to Vercel project. Deploy. Application now has both keys available.
3. **Re-encrypt all rows**: run `scripts/rotate_tenant_config_keys.ts` (Phase 1.4 deliverable). Script:
   - Reads every `tenant_config` row where `encrypted=true`
   - Decrypts with `MYRA_TENANT_CONFIG_KEY` (current)
   - Re-encrypts with `MYRA_TENANT_CONFIG_KEY_NEXT`
   - Writes back atomically per row
   - Logs progress to stdout and `tenant_audit_log` (event_type=`config_key_rotation`)
4. **Verify**: spot-check 10 random rows decrypt correctly with `MYRA_TENANT_CONFIG_KEY_NEXT`.
5. **Cut over**: rename env vars in Vercel — `MYRA_TENANT_CONFIG_KEY_NEXT` → `MYRA_TENANT_CONFIG_KEY`, drop the old. Deploy.
6. **Sweep**: leave the previous key in 1Password for 30 days as a recovery backstop. After 30 days clean, archive (don't delete — needed for forensic decrypt of historical backups).

### Tests required (Phase 1.4)

- **Unit test** — round-trip a known-good fixture (encrypt → decrypt → equality).
- **Negative test** — attempt to decrypt with the wrong key; assert `CryptoDecryptError` is thrown (not a silent garbage return).
- **Tamper test** — flip a byte in the ciphertext; assert decryption fails with `CryptoDecryptError` (GCM tag verification catches this).
- **Nonce reuse test** — encrypt same plaintext twice; assert ciphertexts differ (proves nonce is random).

### Staging key procedure (added 2026-05-01)

Per Patrice Confirmation 2 (Session 3 GO message):

- **Staging key MUST NOT match production key.** Separate keys per env.
- **Generate via `openssl rand -base64 32`.** 32 bytes → 44 base64 chars (or 45 with padding).
- **Storage:** the staging key lives in the staging environment's env vars where the staging application runs (Vercel staging env). It does NOT live in the Neon branch — Neon has no per-branch env-var concept.
- **NOT generated yet** as of Session 3 (2026-05-01) because there is no staging application deployment consuming the staging Neon branch (`br-twilight-wildflower-aidj2s93`). Generation is queued for whichever session deploys a staging app build (likely Session 8 production prep).
- **Production key generation** is a separate procedure handled by Patrice via 1Password before Session 8.
- **Never:** committed to repo; logged in session output; stored in DB; emailed; pasted to chat.

## §2 — Row-Level Security (RLS) — defense-in-depth

Per [ADR-001](./ADR-001-tenant-isolation.md), every Category A table has two RLS policies:

```sql
ALTER TABLE x ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON x
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id')::BIGINT);
CREATE POLICY service_admin_bypass ON x
  FOR ALL
  USING (current_setting('app.role', true) = 'service_admin');
```

### Properties guaranteed

1. **Application bug ≠ data leak.** A query missing `WHERE tenant_id = X` returns 0 rows because `current_setting('app.current_tenant_id')` is unset → cast fails → policy denies.
2. **Service-admin bypass is explicit.** No accidental service-admin queries — the `app.role` setting must be deliberately set per transaction.
3. **No backdoor superuser path.** Postgres superusers bypass RLS by default; Neon's connection user is NOT a superuser. Verified Phase 7.3.

### Rollout cadence

Per-table enablement schedule lives in [RLS_ROLLOUT.md](./RLS_ROLLOUT.md). Default: 1 table/day for ~12 days. Patrice arbitrates acceleration per Question 7 resolution.

### Failure mode

If RLS is misconfigured (e.g., a new table added without policy), the application's `withTenant()` wrapper still injects the `app.current_tenant_id` setting — but without the policy, every row is visible. Mitigation: a Phase 7.3 audit query checks `pg_policies` against the Cat A table list and alerts on missing entries.

## §3 — Tenant resolution security

Per [ADR-002](./ADR-002-tenant-resolution.md), tenant resolution precedence is JWT > service header > tracking token > subdomain. Security implications:

### JWT-vs-subdomain conflict (potential tenant spoofing)

A user authed for tenant 5 visiting `tenant7.myraos.ca` is **rejected with 403** and logged to `tenant_audit_log` with `event_type='tenant_resolution_conflict'`. This catches:
- Copy-pasted URLs between tenants (innocent)
- Hijacked subdomains targeting a logged-in user (malicious)
- Misconfigured customer DNS (operational)

Exception: `super_admin` JWTs (`isSuperAdmin: true`) may legitimately cross subdomains.

### Host header injection

The subdomain extraction validates the Host header against `^[a-z0-9.-]+$` before any DB lookup. A malformed host (`'acme; --'.myraos.ca`) returns 400 immediately — no SQL exposure surface.

### Tracking-token resolution (the chicken-and-egg case)

Public tracking URLs (`/track/{64-char-hex}`) bypass cookie auth and must look up the tenant via the token itself. This is the **only** automatic service-admin escalation in the system. Properties:
- The lookup function `resolveTrackingToken(token)` is the sole caller of `asServiceAdmin('tracking_token_resolution', ...)` outside of explicit super-admin actions.
- Every invocation logs to `tenant_audit_log` with `event_type='tracking_token_resolution'` and the actor as `'system:tracking'`.
- The function's only query is `SELECT tenant_id, load_id FROM tracking_tokens WHERE token = $1 AND expires_at > NOW()`. No other columns selected, no other tables joined.
- A non-existent or expired token returns 404. No information leak about tenant existence.

### Service-to-service header

`X-Tenant-Id` header is **not trusted alone**. Must accompany an `Authorization: Service <token>` where the service token is a JWT signed with `JWT_SECRET` and contains `role:'service_admin'` and the same `tenantId` as the header. Mismatch → 403.

## §4 — Service-admin escalation policy

The `service_admin` role has tenant-isolation bypass via the `service_admin_bypass` RLS policy. Use is governed by these rules:

### Allowed use cases

1. **Cross-tenant analytics for super-admin dashboards** — viewing aggregate metrics across all tenants
2. **Customer support troubleshooting** — Myra staff investigating an issue on behalf of a tenant who has explicitly granted access
3. **Billing reconciliation** — matching Stripe events to tenant subscriptions across all tenants
4. **Tracking-token resolution** — automatic, narrow scope (see §3)
5. **Tenant export / purge** — GDPR/CASL operations
6. **Schema migrations** — Phase M3 RLS enablement, Phase M4 default-drop, etc.
7. **Incident response** — emergency operational fixes (must be logged with reason)

### Prohibited use cases

- Viewing one tenant's data while logged in as another tenant's user (use the super-admin dashboard with explicit role switch)
- Bulk operations across tenants without an audit log entry
- Bypassing RLS to "make the query simpler"
- Long-running cron jobs that run as service_admin without per-tenant iteration

### Mechanism

Every service-admin invocation goes through `asServiceAdmin(reason: string, callback)` in `lib/db/tenant-context.ts`:

```ts
await asServiceAdmin('billing reconciliation - May 2026', async (tx) => {
  const subscriptions = await tx.sql`SELECT * FROM tenant_subscriptions WHERE …`;
  // …
});
```

The `reason` string is required, non-empty, and logged to `tenant_audit_log` with:
- `actor_user_id` (the human operator's user ID, or `'system:<process>'` for automated callers)
- `event_type = 'service_admin_invocation'`
- `event_payload = { reason, query_count, duration_ms }`

### Service-admin role assignment

Per [PERMISSIONS_MATRIX.md](./PERMISSIONS_MATRIX.md), `service_admin` is assignable **only** from the super-admin dashboard, never via tenant admin UI. Granted via direct DB write (Phase 1) or super-admin UI (Phase 5.5). Audit log records every grant/revoke.

## §5 — JWT auth security

Per `MyraTMS/lib/auth.ts` and `MyraTMS/middleware.ts`:

- **Algorithm:** HS256 (HMAC-SHA256) with `JWT_SECRET` env var (32+ char random).
- **Edge runtime:** `verifyJwtEdge()` re-implements HMAC-SHA256 verification via `crypto.subtle` because `jsonwebtoken` cannot run in Edge runtime.
- **Cookie:** `auth-token`, `httpOnly`, `Secure` in production, `SameSite=Lax`, 24h expiry.
- **DApp / cross-origin:** `Authorization: Bearer <jwt>` header.
- **Payload:** see [ADR-002](./ADR-002-tenant-resolution.md) §JWT shape changes — includes `tenantId`, `tenantIds`, optional `isSuperAdmin`.

### Token rotation on auth-related changes

Any change to `JwtPayload` shape OR `JWT_SECRET` invalidates all existing tokens at deploy time. Users re-authenticate on next request. Acceptable per [ADR-004](./ADR-004-migration-strategy.md) — documented in deploy notes.

### Secret rotation

`JWT_SECRET` rotates annually OR on suspected compromise. Procedure:
1. Generate new secret: `openssl rand -base64 32`
2. Cannot do "two-secret" verification window cleanly with HS256 — secret change is a hard cutover.
3. Schedule maintenance window (off-hours), set new env var, redeploy. All users re-login.
4. Document timestamp in `tenant_audit_log` with `event_type='jwt_secret_rotation'`.

For zero-downtime rotation in the future, consider migrating to RS256 (asymmetric) with a kid-based key set.

## §6 — Audit logging requirements

The `tenant_audit_log` table receives append-only entries for:

| Event | Actor | Payload |
|---|---|---|
| `service_admin_invocation` | User ID or `system:<process>` | `{reason, query_count, duration_ms}` |
| `tracking_token_resolution` | `system:tracking` | `{token_prefix, resolved_tenant_id, load_id}` |
| `tenant_resolution_conflict` | User ID (from JWT) | `{jwt_tenant_id, subdomain_tenant_id, host}` |
| `config_key_rotation` | User ID (operator) | `{from_version, to_version, rows_re_encrypted}` |
| `jwt_secret_rotation` | User ID (operator) | `{rotation_at}` |
| `tenant_export_requested` | User ID | `{tenant_id, requested_by, format}` |
| `tenant_purge_executed` | User ID | `{tenant_id, executed_by, row_count, reason}` |
| `tenant_user_role_changed` | User ID (admin) | `{target_user_id, old_role, new_role}` |
| `subscription_tier_changed` | User ID or `system:billing` | `{from_tier, to_tier, reason}` |
| `feature_override_changed` | User ID | `{key, old_value, new_value}` |

### Retention

- 7 years (CASL + audit trail for SOC 2 if pursued).
- Append-only; no UPDATE or DELETE except for super-admin compaction after 7 years.

### Read access

- Tenant admins see only their own tenant's audit log
- `service_admin` users see all tenants
- Direct DB query is the canonical read path; UI views (Phase 5.4) are convenience layers

## §7 — Incident response checklist

If a security incident is suspected:

### Step 1 — Contain (within 1 hour)
- Suspected data leak: check `tenant_audit_log` for unexpected `service_admin_invocation` entries in the last 24h
- Suspected key compromise: rotate the relevant key per §1 or §5 procedure
- Suspected tenant takeover: suspend the affected tenant via `tenant_subscriptions.status = 'suspended'`

### Step 2 — Assess (within 24 hours)
- Identify scope: which tenants affected, which data, time window
- Snapshot the relevant audit log slice: `SELECT * FROM tenant_audit_log WHERE created_at BETWEEN X AND Y`
- Determine root cause (RLS misconfiguration, leaked secret, code bug, social engineering)

### Step 3 — Notify (per regulation)
- CASL / GDPR breach notification timelines (72h)
- Notify Patrice immediately
- Notify affected tenants per contract terms

### Step 4 — Remediate
- Patch the vulnerability
- Verify the patch in staging
- Deploy to production
- Re-run Phase 7.3 security audit suite

### Step 5 — Post-mortem
- Update SECURITY.md with the lesson
- Add a regression test to `tests/multitenant/security/` if applicable
- Document in `tenant_audit_log` with `event_type='incident_response'`

## §8 — Future hardening (deferred)

| Item | Why deferred | When |
|---|---|---|
| Per-tenant Postgres roles (each tenant has own DB role) | RLS already provides the isolation property; per-role adds operational complexity | Trigger: regulated tenant audit demands it |
| RS256 asymmetric JWTs (zero-downtime secret rotation) | HS256 is sufficient for current scale | Trigger: SOC 2 audit or first key-rotation pain point |
| Hardware HSM for `MYRA_TENANT_CONFIG_KEY` | Vercel env var is acceptable for current scale | Trigger: enterprise contract requiring KMS-backed crypto |
| Per-tenant rate limiting at API edge (Cloudflare or Vercel) | Application-layer rate limit covers current load | Trigger: noisy-neighbor incident |
| Web Application Firewall (WAF) | Vercel default WAF + middleware validation suffices | Trigger: targeted attack pattern observed |
| Penetration testing | No external customers yet | Before first SaaS customer goes live |

End of SECURITY.md. Quarterly review next due 2026-08-01.
