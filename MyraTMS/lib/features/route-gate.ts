// =============================================================================
// Route-level feature gate — the exact pattern used by import/execute,
// loads/bulk-match and admin/tenants/[id]/export, factored out so every
// tier-gated route enforces it identically:
//
//   const ctx = requireTenantContext(req)          // 1. auth / tenant
//   const denied = await enforceFeature(ctx.tenantId, "tms_advanced")
//   if (denied) return denied                       // 2. feature gate (403)
//   ...handler...                                   // 3. handler
//
// Returns null when the tenant's tier (with overrides) includes the feature,
// otherwise the gateErrorResponse() 403 { error, code: "feature_unavailable",
// feature, tier }. Non-gate errors (e.g. DB failure loading the
// subscription) propagate, same as the inline pattern.
// =============================================================================

import type { Feature } from "./index"
import { loadTenantSubscription } from "./loader"
import { requireFeature, gateErrorResponse } from "./gate"

export async function enforceFeature(
  tenantId: number,
  feature: Feature,
): Promise<Response | null> {
  try {
    const sub = await loadTenantSubscription(tenantId)
    requireFeature(sub, feature)
    return null
  } catch (err) {
    const resp = gateErrorResponse(err)
    if (resp) return resp
    throw err
  }
}
