// =============================================================================
// Feature definitions — Layer 1 of ADR-003 Three-Layer Gating Model.
//
// Spec: docs/architecture/ADR-003-feature-gating.md §Layer 1
//
// This file is the single source of truth for "what features exist on the
// platform". Adding a new feature is a TWO-step process:
//   1. Add the key + description here (compiler will then catch typos)
//   2. Decide which tiers get it (lib/features/tiers.ts)
//
// Limits work the same way — keys here, tier defaults in tiers.ts.
//
// IMPORTANT: removing a feature key here is a contract break for any tenant
// whose tier or override list mentions it. See ADR-003 §Negative — feature
// deprecation policy is a future Phase 9 deliverable.
// =============================================================================

/**
 * Catalog of all feature flags. The key is what code references; the value
 * is a human-readable description used by the admin dashboard.
 */
export const FEATURES = {
  // TMS core
  tms_basic: "Basic TMS — load CRUD, dispatch, invoicing",
  tms_advanced: "Advanced TMS — custom workflows, bulk import, API access",

  // AutoBroker tier
  autobroker_starter: "AutoBroker — 3 personas, DAT only",
  autobroker_pro: "AutoBroker — custom personas, all load boards",
  autobroker_enterprise:
    "AutoBroker — dedicated infrastructure, custom integrations",

  // Capital
  capital_quick_pay: "Quick Pay carrier financing",
  capital_factoring: "Factoring",
  capital_fuel_card: "Fuel card",

  // Data
  data_lane_intelligence: "Cross-tenant lane rate intelligence",
  data_export: "Bulk data export (GDPR / CASL)",

  // Branding & UX
  whitelabel_branding:
    "White-label voice agent + dashboard + custom domain",
  multi_language: "Multi-language UI + voice agent (EN/FR)",

  // Integration
  api_access: "External API access (REST + webhooks)",
  sso_saml: "SAML SSO",
} as const

/** Type-narrowing helper — every code reference uses this type so typos don't compile. */
export type Feature = keyof typeof FEATURES

/** All known features as a typed array. Order is the catalog order above. */
export const ALL_FEATURES = Object.keys(FEATURES) as Feature[]

/**
 * Catalog of metered limits. Each key has a numeric quota per tier.
 * The unit is implied by the key name (monthly counts, daily counts,
 * concurrent counts).
 */
export const LIMIT_KEYS = {
  personas: "AutoBroker persona count",
  retell_minutes_monthly: "Retell voice minutes per month",
  autobroker_bookings_monthly: "AutoBroker auto-booked loads per month",
  load_boards: "Connected load boards",
  quick_pay_advances_monthly: "Quick Pay advances per month",
  users: "Active user accounts",
  api_requests_daily: "External API requests per day",
} as const

export type LimitKey = keyof typeof LIMIT_KEYS

export const ALL_LIMIT_KEYS = Object.keys(LIMIT_KEYS) as LimitKey[]

/** Subscription tiers per migration 027 tenant_subscriptions.tier CHECK constraint. */
export const TIERS = ["starter", "pro", "enterprise", "internal"] as const
export type Tier = (typeof TIERS)[number]

/**
 * Period buckets for usage tracking. The tracker uses these to scope
 * Redis keys and the cron aggregation to the right window.
 */
export type LimitPeriod = "monthly" | "daily" | "concurrent"

/**
 * Map a limit key to the period it's measured over. Used by the usage
 * tracker to derive the correct Redis key suffix.
 */
export const LIMIT_PERIODS: Record<LimitKey, LimitPeriod> = {
  personas: "concurrent",
  retell_minutes_monthly: "monthly",
  autobroker_bookings_monthly: "monthly",
  load_boards: "concurrent",
  quick_pay_advances_monthly: "monthly",
  users: "concurrent",
  api_requests_daily: "daily",
}
