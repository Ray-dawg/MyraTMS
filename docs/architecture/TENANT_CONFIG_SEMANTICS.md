# TENANT_CONFIG_SEMANTICS.md

> **Cadence:** Updated when defaults change or new config keys are added.
> **Last update:** 2026-05-01 (Session 1, Phase 0)
> **Related:** [ADR-003](./ADR-003-feature-gating.md), [SECURITY.md](./SECURITY.md)

This document codifies how per-tenant configuration is split between two storage mechanisms (`tenant_subscriptions.feature_overrides` and `tenant_config`), why, and how new tenants get their initial config.

## §1 — The split rule

| Storage | Lives in | What goes here | Read pattern |
|---|---|---|---|
| `tenant_subscriptions.feature_overrides` (JSONB) | One row per tenant in `tenant_subscriptions` | Boolean feature flags + numeric limit overrides | Hot-path: read once per request at tenant resolution time, cached in `req.tenant.features` and `req.tenant.limits` |
| `tenant_config` (key-value table) | Many rows per tenant in `tenant_config` | Operational settings, integration credentials, branding, localization | On-demand: read by specific code paths that need a specific key |

### Examples

```
feature_overrides (single JSONB column):
  {
    "addedFeatures": ["sso_saml"],
    "removedFeatures": ["multi_language"],
    "limitOverrides": {
      "personas": 50,
      "retell_minutes_monthly": 100000
    }
  }

tenant_config (separate rows):
  (tenant_id=5, key='currency_default',          value='"CAD"',     encrypted=false)
  (tenant_id=5, key='locale_default',            value='"en-CA"',   encrypted=false)
  (tenant_id=5, key='margin_floor_cad',          value='150',       encrypted=false)
  (tenant_id=5, key='retell_api_key',            value='<encrypted>', encrypted=true)
  (tenant_id=5, key='dat_credentials',           value='<encrypted>', encrypted=true)
  (tenant_id=5, key='branding_logo_url',         value='"https://..."', encrypted=false)
  (tenant_id=5, key='branding_primary_color',    value='"#0066FF"', encrypted=false)
```

### Rationale

- **`feature_overrides` is hot-path.** Every request needs to know "does this tenant have feature X" and "what's the limit for usage Y". Co-locating with subscriptions means one row read per request to resolve all features and limits.
- **`tenant_config` is configuration.** Read in specific code paths (margin calculation reads `margin_floor_cad`; voice agent reads `retell_api_key`). Per-key granularity supports per-key encryption and per-key audit trail.
- **Splitting keeps the JSONB blob small** (better Postgres planner behavior) and keeps the key-value table simple (no mixed semantics).

### Anti-pattern: don't mix

❌ **Do not** put boolean features in `tenant_config`:
```
(tenant_id=5, key='has_autobroker_pro', value='true', encrypted=false)
```
This is a feature flag — it belongs in `feature_overrides`.

❌ **Do not** put credentials in `feature_overrides`:
```
"retellApiKey": "..."
```
This is a credential — it belongs in `tenant_config` with `encrypted=true`.

If a value is both a feature gate AND has structural data (e.g., persona prompt customization gated by Pro tier), keep them separate: the feature flag in `feature_overrides`, the prompt template in `tenant_config`. Code reads both.

## §2 — `DEFAULT_TENANT_CONFIG` constant

Defined in `lib/tenants/defaults.ts` (Phase 1.4 deliverable). Every key listed here is cloned into a new tenant's `tenant_config` at creation time.

```ts
export const DEFAULT_TENANT_CONFIG: ReadonlyArray<{
  key: string;
  value: unknown;
  encrypted: boolean;
  description: string;
}> = [
  // --- Localization ---
  { key: 'currency_default',     value: 'CAD',           encrypted: false, description: 'ISO 4217 currency code for amounts displayed in UI and emails' },
  { key: 'locale_default',       value: 'en-CA',         encrypted: false, description: 'BCP 47 locale tag — drives date/number formatting' },
  { key: 'timezone_default',     value: 'America/Toronto', encrypted: false, description: 'IANA timezone — drives schedule display and check-call windows' },
  { key: 'language_default',     value: 'en',            encrypted: false, description: 'Primary UI language; secondary requires multi_language feature' },

  // --- Operational defaults ---
  { key: 'margin_floor_cad',     value: 150,             encrypted: false, description: 'Minimum margin in CAD; loads under floor get warning, not blocked' },
  { key: 'margin_floor_usd',     value: 110,             encrypted: false, description: 'Minimum margin in USD' },
  { key: 'walk_away_rate_factor', value: 0.92,           encrypted: false, description: 'Carrier rate threshold below which negotiation walks away; 0.92 = 92% of target' },
  { key: 'checkcall_threshold_hours', value: 4,          encrypted: false, description: 'Hours since last check-call before alert raised' },
  { key: 'detention_threshold_minutes', value: 120,      encrypted: false, description: 'Minutes at pickup/delivery before detention flag' },

  // --- Engine 2 / AutoBroker ---
  { key: 'persona_alpha_init',   value: 1.0,             encrypted: false, description: 'Thompson Sampling Beta α prior — defaults match Engine 2 seed' },
  { key: 'persona_beta_init',    value: 1.0,             encrypted: false, description: 'Thompson Sampling Beta β prior' },
  { key: 'auto_book_profit_threshold_cad', value: 200,   encrypted: false, description: 'Minimum profit to trigger auto-book (vs. escalate)' },
  { key: 'shipper_fatigue_max',  value: 2,               encrypted: false, description: 'Max declined calls before shipper enters 7-day cooldown' },

  // --- Branding (placeholder values; updated at onboarding) ---
  { key: 'branding_logo_url',    value: null,            encrypted: false, description: 'Tenant logo URL; null = use Myra default' },
  { key: 'branding_primary_color', value: '#0066FF',     encrypted: false, description: 'Primary brand color hex' },
  { key: 'branding_company_name', value: null,           encrypted: false, description: 'Company name in voice agent script and emails; null = use tenants.name' },

  // --- Communication ---
  { key: 'smtp_from_email',      value: 'noreply@myralogistics.com', encrypted: false, description: 'Per-tenant FROM email; whitelabel tenants override' },
  { key: 'factoring_email',      value: null,            encrypted: false, description: 'Tenant factoring company email; null = factoring disabled' },
  
  // --- Notification preferences ---
  { key: 'notif_checkcall_enabled', value: true,         encrypted: false, description: 'Send check-call reminder notifications' },
  { key: 'notif_invoice_overdue_days', value: 7,         encrypted: false, description: 'Days overdue before invoice alert' },
];
```

### Sensitive keys NOT in `DEFAULT_TENANT_CONFIG`

Integration credentials are NOT defaulted — they're set during onboarding (Phase 3.2 wizard) per tenant. Never seeded with placeholder values:

```
retell_api_key, retell_agent_id_en, retell_agent_id_fr,
dat_credentials, truckstop_credentials, loadboard_123_credentials, loadlink_credentials,
stripe_account_id, persona_api_key,
fmcsa_api_key, samsara_api_token, motive_api_token,
twilio_account_sid, twilio_auth_token, twilio_from_number,
custom_smtp_host, custom_smtp_user, custom_smtp_pass
```

These keys are inserted into `tenant_config` only when the tenant explicitly configures them via the integrations page.

## §3 — Clone-on-create semantics

When a new tenant is provisioned (via super-admin `POST /api/admin/tenants`):

```ts
async function provisionTenant(input: CreateTenantInput): Promise<Tenant> {
  return await asServiceAdmin('tenant_provisioning', async (tx) => {
    const { rows: [tenant] } = await tx.sql`
      INSERT INTO tenants (slug, name, type, status, billing_email)
      VALUES (${input.slug}, ${input.name}, ${input.type}, 'active', ${input.billingEmail})
      RETURNING *
    `;
    
    await tx.sql`
      INSERT INTO tenant_subscriptions (tenant_id, tier, status, started_at)
      VALUES (${tenant.id}, ${input.tier}, 'active', NOW())
    `;
    
    // Clone defaults
    for (const { key, value, encrypted } of DEFAULT_TENANT_CONFIG) {
      const storedValue = encrypted ? encryptValue(JSON.stringify(value)) : JSON.stringify(value);
      await tx.sql`
        INSERT INTO tenant_config (tenant_id, key, value, encrypted)
        VALUES (${tenant.id}, ${key}, ${storedValue}, ${encrypted})
      `;
    }
    
    return tenant;
  });
}
```

### Why clone, not fall-back to global defaults at runtime

Clone-on-create:
- **Settings drift over time per tenant.** Cloning makes that the natural expected behavior. Each tenant's history is independent.
- **Default fallback creates phantom config.** If a tenant relies on a fallback and the global default later changes, behavior changes silently. With cloned values, no surprise.
- **Audit trail is clean.** Every value has an explicit history per tenant. `tenant_audit_log` shows exactly when each value was set.
- **One read covers all.** A `SELECT * FROM tenant_config WHERE tenant_id = X` returns every effective key without joining to a defaults table.

### What if `DEFAULT_TENANT_CONFIG` adds a new key after some tenants exist?

Existing tenants do NOT automatically get the new key. They keep operating with whatever config they have. The new key is added to NEW tenants from the moment of the deploy.

To selectively propagate a new default to existing tenants, run:

```bash
pnpm tsx scripts/sync_tenant_defaults.ts \
  --keys=auto_book_profit_threshold_cad,shipper_fatigue_max \
  --tenants=5,7,9 \
  --dry-run
```

The script:
- Reads `DEFAULT_TENANT_CONFIG` for the specified keys
- For each specified tenant, checks if the key exists; INSERTs if missing, optionally UPDATEs if `--overwrite` flag is set
- Logs every change to `tenant_audit_log` with `event_type='config_default_propagation'`
- `--dry-run` shows planned changes without writing
- `--all-tenants` is supported but requires explicit `--confirm` flag (operational guardrail)

### What if a tenant's config gets corrupted or lost?

Recovery: re-run the clone-on-create logic for that tenant ID, restoring just the missing keys (existing keys untouched unless `--overwrite`):

```bash
pnpm tsx scripts/sync_tenant_defaults.ts --tenants=5 --restore-missing
```

## §4 — Read patterns

### Hot path — features and limits at tenant resolution

```ts
// In middleware.ts (Phase 2.1):
const subscription = await loadSubscription(tenantId);
req.tenant.features = computeEffectiveFeatures(subscription);
req.tenant.limits = computeEffectiveLimits(subscription);
```

`subscription` includes `feature_overrides` JSONB. Computed features/limits cached for the request's lifetime. No per-route DB hit.

### On-demand — config keys read by handlers

```ts
// In a handler that needs the tenant's margin floor:
const marginFloor = await getTenantConfig(tenantCtx, 'margin_floor_cad');

// Implementation:
async function getTenantConfig<T>(ctx: TenantContext, key: string): Promise<T | null> {
  const cached = ctx.configCache.get(key);
  if (cached !== undefined) return cached as T;
  const { rows: [row] } = await ctx.tx.sql`
    SELECT value, encrypted FROM tenant_config WHERE tenant_id = ${ctx.tenantId} AND key = ${key}
  `;
  if (!row) return null;
  const value = row.encrypted ? decryptValue(row.value) : row.value;
  const parsed = JSON.parse(value) as T;
  ctx.configCache.set(key, parsed);
  return parsed;
}
```

`ctx.configCache` is per-request (lives in `withTenant` callback scope). No cross-request caching — config changes take effect on next request.

### Bulk read — admin dashboard

For the tenant admin page that lists all config keys at once:

```ts
const allConfig = await tx.sql`
  SELECT key, value, encrypted FROM tenant_config WHERE tenant_id = ${tenantId} ORDER BY key
`;
// Decrypt the encrypted ones, mask credentials in UI:
const display = allConfig.map(c => ({
  key: c.key,
  value: c.encrypted ? maskCredential(decrypt(c.value)) : JSON.parse(c.value),
  encrypted: c.encrypted,
}));
```

`maskCredential('sk_live_abcdef123456')` returns `'sk_live_***3456'`. Full plaintext never returned to UI.

## §5 — Updating config

API: `PATCH /api/admin/config/[key]` (Phase 3.1 deliverable):

```ts
{
  "value": "America/Vancouver",      // new value (typed per key)
  "reason": "Tenant requested PST"   // required for audit log
}
```

Behavior:
- Requires `admin` or `owner` role (per `PERMISSIONS_MATRIX.md` §3.1)
- Encrypted keys: encryption happens server-side; client never handles ciphertext
- Updates `tenant_config.value` for that key; if encrypted=true, re-encrypts
- Logs to `tenant_audit_log` with `event_type='tenant_config_changed'` and `payload={key, old_value: '<masked>', new_value: '<masked>', reason}`
- For encrypted keys, audit log records `<encrypted>` as the value (not the plaintext)

## §6 — Schema reference

```sql
CREATE TABLE tenant_config (
    tenant_id BIGINT NOT NULL REFERENCES tenants(id),
    key       VARCHAR(100) NOT NULL,
    value     TEXT NOT NULL,
    encrypted BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by TEXT,
    PRIMARY KEY (tenant_id, key)
);

CREATE INDEX idx_tenant_config_tenant ON tenant_config (tenant_id);
```

`value` is TEXT (not JSONB) because:
- Encrypted values are arbitrary base64 strings, not parseable JSON
- Plaintext values can still hold JSON-encoded data (`'"CAD"'` for a string, `'150'` for a number) and parse on read
- Consistent storage type simplifies the encrypt/decrypt path

`updated_by` records the user ID of the last writer (NULL for system writes).

## §7 — Validation per key

Phase 3.2 onboarding wizard and Phase 3.1 admin API validate per-key value shapes:

```ts
// lib/tenants/config-schema.ts
export const TENANT_CONFIG_VALIDATORS: Record<string, z.ZodSchema> = {
  currency_default: z.enum(['CAD', 'USD', 'EUR', 'GBP']),
  locale_default: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
  timezone_default: z.string(), // IANA timezone validation handled at runtime
  margin_floor_cad: z.number().min(0).max(10000),
  walk_away_rate_factor: z.number().min(0.5).max(1.0),
  branding_primary_color: z.string().regex(/^#[0-9A-F]{6}$/i),
  branding_logo_url: z.string().url().nullable(),
  // … etc
};
```

Updates rejected if value fails validation. Centralized so the wizard, API, and `sync_tenant_defaults.ts` all use the same schema.

End of TENANT_CONFIG_SEMANTICS.md.
