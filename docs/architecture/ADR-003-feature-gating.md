# ADR-003 — Feature Gating Strategy

| | |
|---|---|
| **Status** | **Approved 2026-05-01** (Patrice resolution round 2) |
| **Date** | 2026-05-01 |
| **Deciders** | Patrice Penda |
| **Drafter** | Claude (Opus 4.7) |
| **Depends on** | [ADR-001](./ADR-001-tenant-isolation.md), [ADR-002](./ADR-002-tenant-resolution.md) |
| **Companion docs** | [TENANT_CONFIG_SEMANTICS.md](./TENANT_CONFIG_SEMANTICS.md) (config vs feature_overrides split rule), [BILLING_DEFERRED.md](./BILLING_DEFERRED.md) (Stripe scope deferred to standalone session) |

## Context

MyraTMS will sell to multiple tenants under three subscription tiers (Starter, Pro, Enterprise) plus the operating-company internal tier. Each tier exposes a different set of features (TMS basic vs. advanced workflows; AutoBroker tier; Capital products; whitelabel; multi-language; API access) and different metered limits (persona count, Retell minutes, AutoBroker bookings, Quick Pay advances).

Two distinct concerns share the term "feature gating":

| Concern | Type | Examples | Failure mode |
|---|---|---|---|
| **Feature access** | Boolean | "Does this tenant have AutoBroker Pro?" "Can this tenant access whitelabel branding?" | 403 Forbidden — gate is binary |
| **Usage limits** | Numeric (with thresholds) | "Has this tenant exceeded its 50,000 monthly Retell minutes?" "Has this tenant booked >100 loads this month on the Starter plan?" | Throttle (warn at 80%, hard-block at 100%, soft-block configurable) |

The mega-prompt prescribes:
- Server-side feature flags, defined per subscription tier
- Loaded into request context at tenant resolution time
- UI hides features the tenant doesn't have access to
- **UI hiding is cosmetic — server enforces**

This ADR codifies that direction and addresses the limits concern that the prompt mentions in Phase 4.4 but doesn't fully architect.

## Decision

### Three-layer gating model

```
┌──────────────────────────────────────────────────────┐
│ Layer 1 — DEFINITIONS (TypeScript constants)         │
│   FEATURES, FEATURE_DESCRIPTIONS, LIMIT_KEYS         │
└──────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────┐
│ Layer 2 — TIER MAPPING (TypeScript + DB overrides)   │
│   TIER_FEATURES, TIER_LIMITS                         │
│   tenant_subscriptions.feature_overrides JSONB       │
└──────────────────────────────────────────────────────┘
                        ↓
┌──────────────────────────────────────────────────────┐
│ Layer 3 — ENFORCEMENT (server + worker, never UI)    │
│   requireFeature(feature) — boolean gate             │
│   withinLimit(key, currentUsage) — numeric gate      │
│   hasFeature(feature) — non-throwing read for UI     │
└──────────────────────────────────────────────────────┘
```

### Layer 1 — Definitions (`lib/features/index.ts`)

```ts
export const FEATURES = {
  // TMS core
  'tms_basic': 'Basic TMS — load CRUD, dispatch, invoicing',
  'tms_advanced': 'Advanced TMS — custom workflows, bulk import, API access',

  // AutoBroker tier
  'autobroker_starter': 'AutoBroker — 3 personas, DAT only',
  'autobroker_pro': 'AutoBroker — custom personas, all load boards',
  'autobroker_enterprise': 'AutoBroker — dedicated infrastructure, custom integrations',

  // Capital
  'capital_quick_pay': 'Quick Pay carrier financing',
  'capital_factoring': 'Factoring',
  'capital_fuel_card': 'Fuel card',

  // Data
  'data_lane_intelligence': 'Cross-tenant lane rate intelligence',
  'data_export': 'Bulk data export (GDPR / CASL)',

  // Branding & UX
  'whitelabel_branding': 'White-label voice agent + dashboard + custom domain',
  'multi_language': 'Multi-language UI + voice agent (EN/FR)',

  // Integration
  'api_access': 'External API access (REST + webhooks)',
  'sso_saml': 'SAML SSO',
} as const;

export type Feature = keyof typeof FEATURES;

export const LIMIT_KEYS = {
  'personas': 'AutoBroker persona count',
  'retell_minutes_monthly': 'Retell voice minutes per month',
  'autobroker_bookings_monthly': 'AutoBroker auto-booked loads per month',
  'load_boards': 'Connected load boards',
  'quick_pay_advances_monthly': 'Quick Pay advances per month',
  'users': 'Active user accounts',
  'api_requests_daily': 'External API requests per day',
} as const;

export type LimitKey = keyof typeof LIMIT_KEYS;
```

### Layer 2 — Tier mapping (`lib/features/tiers.ts`)

```ts
export const TIER_FEATURES: Record<Tier, Feature[]> = {
  starter: ['tms_basic', 'autobroker_starter'],
  pro: [
    'tms_basic', 'tms_advanced',
    'autobroker_pro',
    'capital_quick_pay', 'capital_fuel_card',
    'data_lane_intelligence',
    'multi_language',
  ],
  enterprise: Object.keys(FEATURES) as Feature[], // all features
  internal: Object.keys(FEATURES) as Feature[],   // operating companies get everything
};

export const TIER_LIMITS: Record<Tier, Record<LimitKey, number>> = {
  starter:    { personas: 3,        retell_minutes_monthly: 5000,   autobroker_bookings_monthly: 25,   load_boards: 1, quick_pay_advances_monthly: 0,    users: 5,    api_requests_daily: 0 },
  pro:        { personas: 10,       retell_minutes_monthly: 50000,  autobroker_bookings_monthly: 250,  load_boards: 3, quick_pay_advances_monthly: 50,   users: 25,   api_requests_daily: 10000 },
  enterprise: { personas: Infinity, retell_minutes_monthly: Infinity, autobroker_bookings_monthly: Infinity, load_boards: Infinity, quick_pay_advances_monthly: Infinity, users: Infinity, api_requests_daily: Infinity },
  internal:   { personas: Infinity, retell_minutes_monthly: Infinity, autobroker_bookings_monthly: Infinity, load_boards: Infinity, quick_pay_advances_monthly: Infinity, users: Infinity, api_requests_daily: Infinity },
};
```

**Per-tenant overrides** live in `tenant_subscriptions.feature_overrides` JSONB:
```json
{
  "addedFeatures": ["sso_saml"],         // grant beyond tier
  "removedFeatures": ["multi_language"], // revoke from tier
  "limitOverrides": {
    "personas": 50,                       // raise/lower a single limit
    "retell_minutes_monthly": 100000
  }
}
```

Used for: enterprise contracts that include features outside their tier; pilot programs that grant Pro features to a Starter tenant; emergency limit raises for a tenant in production.

### Layer 3 — Enforcement (`lib/features/gate.ts`)

```ts
// Throwing API used in route handlers and worker process()
export function requireFeature(tenant: Tenant, feature: Feature): void {
  if (!hasFeature(tenant, feature)) {
    throw new FeatureUnavailableError(feature, tenant.subscriptionTier);
    // FeatureUnavailableError extends ApiError(403, ...)
  }
}

export async function withinLimit(
  tenant: Tenant,
  key: LimitKey,
  currentUsage: number,
): Promise<void> {
  const limit = resolveLimit(tenant, key);
  if (limit === Infinity) return;

  if (currentUsage >= limit * 2) {
    // 200% — soft block (configurable per tenant)
    throw new LimitExceededError(key, currentUsage, limit, 'hard_block');
  }
  if (currentUsage >= limit) {
    // 100% — hard limit
    throw new LimitExceededError(key, currentUsage, limit, 'limit_reached');
  }
  // 80% threshold triggers a notification (not a block) — handled by usage tracker
}

// Non-throwing read used by UI for cosmetic hiding
export function hasFeature(tenant: Tenant, feature: Feature): boolean {
  const tierFeatures = TIER_FEATURES[tenant.subscriptionTier];
  const overrides = tenant.subscription.featureOverrides ?? {};
  const added = overrides.addedFeatures ?? [];
  const removed = overrides.removedFeatures ?? [];
  return (tierFeatures.includes(feature) || added.includes(feature)) && !removed.includes(feature);
}
```

### Where enforcement runs

| Surface | What enforces | How |
|---|---|---|
| API routes | `requireFeature` / `withinLimit` at top of handler | Throws → caught by `apiError` wrapper → returns 403/429 |
| BullMQ workers | `requireFeature` / `withinLimit` at top of `process()` | Throws → job moves to dead-letter, alert raised |
| Cron jobs | Iterator skips tenants that don't have the feature | E.g., `shipper-reports` skips tenants without `data_lane_intelligence` |
| UI | `hasFeature()` returns boolean — used in `useFeatures()` React hook | Hides menu items, disables buttons. **Cosmetic only.** |
| Database | RLS doesn't enforce features (only isolation). Feature gating is NOT defense-in-depth at DB layer. | Out of scope for RLS. |

### How tenant context loads features

In Phase 2.1 middleware, after tenant resolution:

```ts
const tenant = await loadTenant(tenantId);
const subscription = await loadSubscription(tenantId);
req.tenant = {
  id: tenant.id,
  slug: tenant.slug,
  type: tenant.type,
  status: tenant.status,
  subscriptionTier: subscription.tier,
  features: computeEffectiveFeatures(subscription),  // resolved with overrides
  limits: computeEffectiveLimits(subscription),
  subscription,
};
```

The full `req.tenant` object is then available to every API route and via the `getServerSession()` (or equivalent) helper for server components.

`features` and `limits` are computed once per request and cached in memory for the request's duration. Subscription changes (upgrade, downgrade, cancellation) take effect on the next request — no need for cross-request invalidation.

### Usage tracking — separate concern

Per Phase 4.4, `lib/usage/tracker.ts`:
- Increments per-tenant counters in Redis (`tenant:{id}:usage:{key}:{period}`) on each event
- Daily aggregation cron reads Redis, writes to a `tenant_usage` table (Phase 4.4 schema add)
- Dashboard reads `tenant_usage` (not Redis) for historical charts
- Alerts fire when usage / limit ≥ 0.8 (warn), ≥ 1.0 (limit reached), ≥ 1.5 (over by 50%), ≥ 2.0 (soft-block trigger)

Threshold actions:
- 80%: notification to tenant admin
- 100%: notification + `withinLimit` starts throwing on metered routes
- 150%: notification + email to billing team
- 200%: hard block (configurable to grace period)

## Consequences

### Positive

- **Server-authoritative.** UI bypass attacks (DevTools, replay) hit the server gate. UI hiding is purely UX.
- **Cleanly separates access vs. limits.** Boolean features and numeric limits use different APIs (`requireFeature` vs `withinLimit`) — no confusing overload.
- **Override layer for pilots and contracts.** Enterprise customers and pilot programs can deviate from tier defaults without code changes.
- **One source of truth.** Features defined once in `lib/features/index.ts`; tier mappings in `lib/features/tiers.ts`; never duplicated in routes.
- **Worker enforcement.** BullMQ workers gate the same way as API routes. A Pro tenant cannot get Enterprise behavior by sneaking jobs into the queue.
- **Cron filtering.** Cron iterators skip tenants without the feature, so `shipper-reports` doesn't run for Starter tenants who don't have lane intelligence.

### Negative

- **`Infinity` is a sentinel value** for unlimited tier limits. JS handles `Infinity` correctly in arithmetic but JSON serialization needs care (Infinity → null). Mitigated by helper that emits `null` for "unlimited" in API responses and parses both back.
- **Two sources of feature truth** (TypeScript constants for tier defaults + JSONB overrides per tenant). The combine logic must be auditable — a single `computeEffectiveFeatures()` function that's covered by unit tests.
- **No migration path for tier removal.** Once Pro tenants depend on a feature, removing it from the Pro tier breaks them. Mitigated by: feature deprecation policy (announce N months ahead) + override grandfathering for affected tenants.
- **Limit overrides are JSONB, not typed.** Easy to accidentally write a typo (`person` instead of `personas`) and have it silently ignored. Mitigated by: a Zod schema for `feature_overrides` validated on UPDATE.
- **Usage tracking adds Redis writes per metered event.** Acceptable cost; Upstash handles 10k+ ops/sec on the free tier.

### Neutral

- The `internal` tier intentionally gets all features. Operating companies (Tenant 1, Tenant 2 Sudbury) are Myra-owned and don't pay subscriptions.

## Alternatives considered

### Database-only feature flags (no TypeScript constants)

**Rejected.** Adding a feature would require a DB migration, and no TypeScript type checking would prevent typos. Too easy to write `requireFeature('autobrokerstarter')` (typo) and have it always throw. Constants give us compiler-checked feature names.

### LaunchDarkly / Unleash / Statsig

**Rejected for now.** These are excellent for A/B testing, gradual rollouts, and percentage-based gating. Multi-tenant subscription gating is a different use case — much simpler, fewer flags, longer-lived. Adding a SaaS dependency for what's essentially a static lookup is overkill.

If we later need A/B testing for AutoBroker persona variants or rollout controls for new TMS features, we can add LaunchDarkly alongside this system. The two would coexist: LD for experimentation, this system for subscription tier.

### Stripe metadata as the source of truth

**Considered.** Stripe Product metadata could hold feature lists. Pros: one place to update, sales team-friendly. Cons: ties feature gating to Stripe being available; coupling code logic to Stripe API; Stripe is the eventual billing system but isn't yet integrated.

Use Stripe metadata as the **trigger** for `tenant_subscriptions.tier` updates (via webhook handler in Phase 4.5), but the source of truth for what each tier MEANS stays in TypeScript.

### Per-feature DB column on `tenants`

**Rejected.** Boolean columns per feature → schema churn every time a feature is added. JSONB on `tenant_subscriptions.feature_overrides` is the right shape — additions are runtime data, not schema.

## Out-of-scope decisions deferred

- **Feature deprecation policy** (how to retire a feature without breaking dependent tenants). Phase 9 documentation deliverable.
- **Per-feature billing line items.** Stripe usage-based billing for metered features (e.g., $0.01 per Retell minute over the included allowance). **Deferred to standalone billing session** per Patrice Q8 resolution — full scope and starting point in [BILLING_DEFERRED.md](./BILLING_DEFERRED.md).
- **Limit override approval workflow.** Today an admin can write `feature_overrides` directly. Future: require dual-control or an approval ticket. Defer to Phase 5.5 super-admin UI.
- **Feature flag rollout gates** (e.g., enable `autobroker_pro` for tenants in cohort X first). Use a separate tool if/when needed.

## Validation

This ADR is satisfied when:
1. Phase 4.1 `lib/features/index.ts` exposes `FEATURES` and `LIMIT_KEYS` constants.
2. Phase 4.2 `lib/features/tiers.ts` exposes `TIER_FEATURES` and `TIER_LIMITS`.
3. Phase 4.3 `lib/features/gate.ts` exposes `requireFeature`, `withinLimit`, `hasFeature`.
4. Every API route that exposes a tier-gated capability calls `requireFeature` (audit trail in `API_REFACTOR_LOG.md`).
5. Phase 7.1 test suite scenario 3 (tenant downgrade — features become unavailable) passes.
6. Phase 7.3 security audit verifies that UI bypass cannot escalate access.
