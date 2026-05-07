// =============================================================================
// Tier mapping + override resolution — Layer 2 of ADR-003 Three-Layer Gating.
//
// Spec: docs/architecture/ADR-003-feature-gating.md §Layer 2
//
// This file holds:
//   - TIER_FEATURES: which features each tier ships with
//   - TIER_LIMITS:   numeric quotas each tier has (Infinity = unlimited)
//   - computeEffectiveFeatures / computeEffectiveLimits: resolve overrides
//     from tenant_subscriptions.feature_overrides JSONB
//
// All combine logic is here, never in route handlers. The override JSONB
// shape is validated by FEATURE_OVERRIDES_SCHEMA (Zod) — tenant_subscriptions
// UPDATE flows should validate before write to catch typos like 'person'
// vs 'personas'.
// =============================================================================

import { z } from "zod"
import {
  ALL_FEATURES,
  ALL_LIMIT_KEYS,
  type Feature,
  type LimitKey,
  type Tier,
} from "./index"

/**
 * Feature lists per tier. Lower tiers are subsets of higher tiers (with
 * intentional exceptions — e.g., enterprise gets sso_saml that pro does not).
 *
 * Internal tier (operating companies like Myra-owned tenants) gets
 * everything. Starter gets the smallest set.
 */
export const TIER_FEATURES: Record<Tier, ReadonlyArray<Feature>> = {
  starter: ["tms_basic", "autobroker_starter"],
  pro: [
    "tms_basic",
    "tms_advanced",
    "autobroker_pro",
    "capital_quick_pay",
    "capital_fuel_card",
    "data_lane_intelligence",
    "multi_language",
    "api_access",
  ],
  enterprise: [...ALL_FEATURES],
  internal: [...ALL_FEATURES],
}

/**
 * Numeric quotas per tier per limit key. `Infinity` = no cap; arithmetic
 * comparisons (`currentUsage >= limit`) work correctly with Infinity.
 *
 * For JSON serialization (admin API response), `Infinity` is converted
 * to `null` by limitToJson() / parsed back by limitFromJson(). Never
 * write Infinity directly to JSON output.
 */
export const TIER_LIMITS: Record<Tier, Record<LimitKey, number>> = {
  starter: {
    personas: 3,
    retell_minutes_monthly: 5_000,
    autobroker_bookings_monthly: 25,
    load_boards: 1,
    quick_pay_advances_monthly: 0,
    users: 5,
    api_requests_daily: 0,
  },
  pro: {
    personas: 10,
    retell_minutes_monthly: 50_000,
    autobroker_bookings_monthly: 250,
    load_boards: 3,
    quick_pay_advances_monthly: 50,
    users: 25,
    api_requests_daily: 10_000,
  },
  enterprise: {
    personas: Infinity,
    retell_minutes_monthly: Infinity,
    autobroker_bookings_monthly: Infinity,
    load_boards: Infinity,
    quick_pay_advances_monthly: Infinity,
    users: Infinity,
    api_requests_daily: Infinity,
  },
  internal: {
    personas: Infinity,
    retell_minutes_monthly: Infinity,
    autobroker_bookings_monthly: Infinity,
    load_boards: Infinity,
    quick_pay_advances_monthly: Infinity,
    users: Infinity,
    api_requests_daily: Infinity,
  },
}

/**
 * Zod schema for the tenant_subscriptions.feature_overrides JSONB.
 *
 * Shape per ADR-003 §Layer 2:
 *   {
 *     "addedFeatures":   ["sso_saml"],
 *     "removedFeatures": ["multi_language"],
 *     "limitOverrides":  { "personas": 50 }
 *   }
 *
 * Use this on PATCH /api/admin/tenants/[id]/subscription to reject typos
 * before they end up in the JSONB column where they'd be silently ignored.
 */
export const FEATURE_OVERRIDES_SCHEMA = z
  .object({
    addedFeatures: z.array(z.enum(ALL_FEATURES as [Feature, ...Feature[]])).optional(),
    removedFeatures: z
      .array(z.enum(ALL_FEATURES as [Feature, ...Feature[]]))
      .optional(),
    limitOverrides: z
      .record(z.enum(ALL_LIMIT_KEYS as [LimitKey, ...LimitKey[]]), z.number())
      .optional(),
  })
  .strict()

export type FeatureOverrides = z.infer<typeof FEATURE_OVERRIDES_SCHEMA>

/**
 * Compute the effective feature set for a tenant given its tier and any
 * per-tenant overrides. Pure function — same inputs always produce same
 * output. No DB or Redis access.
 */
export function computeEffectiveFeatures(
  tier: Tier,
  overrides: FeatureOverrides | null | undefined,
): Feature[] {
  const base = new Set<Feature>(TIER_FEATURES[tier])
  if (overrides?.addedFeatures) {
    for (const f of overrides.addedFeatures) base.add(f)
  }
  if (overrides?.removedFeatures) {
    for (const f of overrides.removedFeatures) base.delete(f)
  }
  // Return in the canonical order from FEATURES so output is stable
  // across calls — useful for caching / change detection.
  return ALL_FEATURES.filter((f) => base.has(f))
}

/**
 * Compute the effective limit map for a tenant given its tier and any
 * per-tenant override raises/lowers. Returns a fresh object — caller may
 * mutate without affecting TIER_LIMITS.
 */
export function computeEffectiveLimits(
  tier: Tier,
  overrides: FeatureOverrides | null | undefined,
): Record<LimitKey, number> {
  const base = { ...TIER_LIMITS[tier] }
  if (overrides?.limitOverrides) {
    for (const [k, v] of Object.entries(overrides.limitOverrides)) {
      if (k in base && typeof v === "number") {
        ;(base as Record<string, number>)[k] = v
      }
    }
  }
  return base
}

/**
 * Convert a possibly-Infinity limit to JSON-safe form (`null` = unlimited).
 * Use when emitting effective limits to API responses.
 */
export function limitToJson(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

/**
 * Inverse of limitToJson — `null` becomes Infinity, numbers pass through.
 * Use when parsing effective limits from a stored API response.
 */
export function limitFromJson(value: number | null): number {
  return value === null ? Infinity : value
}
