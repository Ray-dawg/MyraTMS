// =============================================================================
// Tenant subscription loader — wraps the DB read that produces a
// ResolvedSubscription for a given tenantId.
//
// Spec: docs/architecture/ADR-003-feature-gating.md §How tenant context loads features
//
// Routes use this to gate per-request:
//   const ctx = requireTenantContext(req)
//   const sub = await loadTenantSubscription(ctx.tenantId)
//   requireFeature(sub, "autobroker_pro")
//
// The subscription is request-scoped — there is no cross-request cache.
// A subscription tier change (upgrade/downgrade) takes effect on the
// next request. This avoids the cache-coherency cost of invalidating
// per-tenant view state on every change.
// =============================================================================

import { withTenant } from "@/lib/db/tenant-context"
import {
  resolveSubscription,
  type ResolvedSubscription,
} from "./gate"
import {
  FEATURE_OVERRIDES_SCHEMA,
  type FeatureOverrides,
} from "./tiers"
import type { Tier } from "./index"

/**
 * Load and resolve the subscription for a tenant. Pulls from
 * tenant_subscriptions (RLS-scoped to the tenant via withTenant).
 *
 * Returns the canonical 'starter' tier with no overrides if no
 * subscription row exists — this is the safe default for tenants
 * created before the subscription is provisioned.
 */
export async function loadTenantSubscription(
  tenantId: number,
): Promise<ResolvedSubscription> {
  const sub = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query<{
      tier: string
      status: string
      feature_overrides: unknown
    }>(
      `SELECT tier, status, feature_overrides
         FROM tenant_subscriptions
        WHERE tenant_id = $1
        LIMIT 1`,
      [tenantId],
    )
    return rows[0] ?? null
  })

  if (!sub) {
    // No subscription row — treat as starter / active. This is the safe
    // default; admin should provision a subscription explicitly.
    return resolveSubscription(tenantId, "starter", "active", null)
  }

  // Validate the JSONB overrides — typos in the field names are silent
  // failures otherwise. If the row is malformed we log and treat as
  // no-overrides rather than crash the request.
  let parsed: FeatureOverrides | null = null
  if (sub.feature_overrides && typeof sub.feature_overrides === "object") {
    const result = FEATURE_OVERRIDES_SCHEMA.safeParse(sub.feature_overrides)
    if (result.success) {
      parsed = result.data
    } else {
      // eslint-disable-next-line no-console
      console.error(
        `[features] tenant ${tenantId} has malformed feature_overrides:`,
        result.error.issues,
      )
    }
  }

  return resolveSubscription(
    tenantId,
    sub.tier as Tier,
    sub.status,
    parsed,
  )
}
