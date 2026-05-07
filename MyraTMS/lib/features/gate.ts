// =============================================================================
// Feature gate enforcement — Layer 3 of ADR-003 Three-Layer Gating Model.
//
// Spec: docs/architecture/ADR-003-feature-gating.md §Layer 3
//
// Three APIs:
//   - requireFeature(subscription, feature) — throws on missing feature.
//     Use at the top of route handlers and BullMQ worker process() methods.
//   - withinLimit(subscription, key, currentUsage) — throws when usage
//     reaches the tier limit. Threshold semantics per ADR-003.
//   - hasFeature(subscription, feature) — non-throwing read for UI.
//
// Errors are mapped to HTTP responses by lib/api-error.ts: 403 for missing
// feature, 429 for limit reached. Workers should let them propagate so the
// job moves to the dead-letter queue with the reason in the failure record.
// =============================================================================

import type { Feature, LimitKey, Tier } from "./index"
import {
  computeEffectiveFeatures,
  computeEffectiveLimits,
  type FeatureOverrides,
} from "./tiers"

/**
 * Resolved subscription view used by the gating helpers. Caller is
 * responsible for loading this from tenant_subscriptions and passing it in
 * — gate functions are pure so they can be tested without DB access.
 */
export interface ResolvedSubscription {
  tenantId: number
  tier: Tier
  status: string
  effectiveFeatures: Feature[]
  effectiveLimits: Record<LimitKey, number>
}

/**
 * Build a ResolvedSubscription from the raw tier + overrides JSONB row.
 * Centralized so route code never has to touch tiers.ts directly.
 */
export function resolveSubscription(
  tenantId: number,
  tier: Tier,
  status: string,
  overrides: FeatureOverrides | null,
): ResolvedSubscription {
  return {
    tenantId,
    tier,
    status,
    effectiveFeatures: computeEffectiveFeatures(tier, overrides),
    effectiveLimits: computeEffectiveLimits(tier, overrides),
  }
}

/**
 * Thrown when a tenant's tier (with overrides applied) does not include
 * the requested feature. Maps to HTTP 403.
 */
export class FeatureUnavailableError extends Error {
  readonly statusCode = 403
  readonly feature: Feature
  readonly tier: Tier
  constructor(feature: Feature, tier: Tier) {
    super(
      `Feature '${feature}' is not available on the '${tier}' subscription tier`,
    )
    this.name = "FeatureUnavailableError"
    this.feature = feature
    this.tier = tier
  }
}

export type LimitBlockReason = "limit_reached" | "hard_block"

/**
 * Thrown when a tenant has reached or exceeded a metered limit.
 * `reason` distinguishes the 100% (limit_reached) from the 200%
 * (hard_block) thresholds — UI can show different copy.
 *
 * Maps to HTTP 429 (Too Many Requests).
 */
export class LimitExceededError extends Error {
  readonly statusCode = 429
  readonly key: LimitKey
  readonly currentUsage: number
  readonly limit: number
  readonly reason: LimitBlockReason
  constructor(
    key: LimitKey,
    currentUsage: number,
    limit: number,
    reason: LimitBlockReason,
  ) {
    super(
      `Limit '${key}' ${reason === "hard_block" ? "hard-blocked" : "reached"}: ${currentUsage}/${limit}`,
    )
    this.name = "LimitExceededError"
    this.key = key
    this.currentUsage = currentUsage
    this.limit = limit
    this.reason = reason
  }
}

/**
 * Throwing gate. Use at the top of any route or worker handler that
 * implements a tier-gated capability. The error is caught by the route
 * handler's catch block (or by BullMQ's job-failure mechanism) and
 * surfaces as a 403.
 */
export function requireFeature(
  subscription: ResolvedSubscription,
  feature: Feature,
): void {
  if (!hasFeature(subscription, feature)) {
    throw new FeatureUnavailableError(feature, subscription.tier)
  }
}

/**
 * Non-throwing read. Use in UI hooks (useFeatures()) and conditional
 * rendering. UI hiding is COSMETIC ONLY — the server gate (requireFeature)
 * is what enforces. See ADR-003 §Where enforcement runs.
 */
export function hasFeature(
  subscription: ResolvedSubscription,
  feature: Feature,
): boolean {
  return subscription.effectiveFeatures.includes(feature)
}

/**
 * Resolve the effective limit (with overrides applied) for a key. Useful
 * for displaying "X of Y used" in the UI, or building rate-limit headers.
 */
export function resolveLimit(
  subscription: ResolvedSubscription,
  key: LimitKey,
): number {
  return subscription.effectiveLimits[key]
}

/**
 * Numeric gate. Pass the current usage (typically from the usage tracker
 * in lib/usage/tracker.ts) and the helper compares it to the effective
 * limit:
 *   - usage < 0.8 × limit  → ok
 *   - usage in [0.8, 1.0)  → ok (warning is the tracker's job, not ours)
 *   - usage >= 1.0 × limit → throws limit_reached
 *   - usage >= 2.0 × limit → throws hard_block
 *
 * Infinity limits always pass through.
 */
export function withinLimit(
  subscription: ResolvedSubscription,
  key: LimitKey,
  currentUsage: number,
): void {
  const limit = subscription.effectiveLimits[key]
  if (!Number.isFinite(limit)) return
  if (currentUsage >= limit * 2) {
    throw new LimitExceededError(key, currentUsage, limit, "hard_block")
  }
  if (currentUsage >= limit) {
    throw new LimitExceededError(key, currentUsage, limit, "limit_reached")
  }
}

/**
 * Returns the threshold band for the current usage. The usage tracker
 * uses this to decide whether to fire a notification on the 80% / 100% /
 * 150% / 200% boundaries (per ADR-003 §Usage tracking — Threshold actions).
 *
 *   < 0.8  → 'normal'
 *   [0.8, 1.0)  → 'warn'
 *   [1.0, 1.5)  → 'limit_reached'
 *   [1.5, 2.0)  → 'over'
 *   >= 2.0     → 'hard_block'
 *
 * For Infinity limits returns 'normal' regardless of usage.
 */
export type UsageBand = "normal" | "warn" | "limit_reached" | "over" | "hard_block"

/**
 * Map a gate-thrown error to a standard NextResponse. Returns null if
 * the error is not a gate error — caller should re-throw or handle
 * upstream.
 *
 * Usage:
 *   try {
 *     requireFeature(sub, "autobroker_pro")
 *     // ... handler body ...
 *   } catch (err) {
 *     const resp = gateErrorResponse(err)
 *     if (resp) return resp
 *     throw err
 *   }
 */
export function gateErrorResponse(err: unknown): Response | null {
  if (err instanceof FeatureUnavailableError) {
    return new Response(
      JSON.stringify({
        error: err.message,
        code: "feature_unavailable",
        feature: err.feature,
        tier: err.tier,
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    )
  }
  if (err instanceof LimitExceededError) {
    return new Response(
      JSON.stringify({
        error: err.message,
        code: "limit_exceeded",
        key: err.key,
        usage: err.currentUsage,
        limit: err.limit,
        reason: err.reason,
      }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    )
  }
  return null
}

export function usageBand(
  subscription: ResolvedSubscription,
  key: LimitKey,
  currentUsage: number,
): UsageBand {
  const limit = subscription.effectiveLimits[key]
  if (!Number.isFinite(limit) || limit <= 0) return "normal"
  const ratio = currentUsage / limit
  if (ratio >= 2.0) return "hard_block"
  if (ratio >= 1.5) return "over"
  if (ratio >= 1.0) return "limit_reached"
  if (ratio >= 0.8) return "warn"
  return "normal"
}
