import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { loadTenantSubscription } from "@/lib/features/loader"
import { limitToJson } from "@/lib/features/tiers"
import type { LimitKey } from "@/lib/features"

/**
 * GET /api/me/tenant
 *
 * Returns the current user's tenant + subscription view, suitable for
 * driving the client-side TenantContext / useFeatures() hook. Encrypted
 * config values are NOT included here (those go through the masked
 * /api/admin/config endpoint) — this is the lightweight per-request
 * payload that runs on every page load via SWR.
 *
 * Shape:
 *   {
 *     tenant: { id, slug, name, type, status },
 *     user:   { id, role, isSuperAdmin },
 *     subscription: {
 *       tier, status,
 *       features: Feature[],
 *       limits:   { [LimitKey]: number | null }   // Infinity → null
 *     },
 *     branding: {
 *       primaryColor: string | null,
 *       logoUrl: string | null,
 *       companyName: string | null
 *     }
 *   }
 */
export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const ctx = requireTenantContext(req)

  // Pull tenant row + the three branding config keys in one round-trip
  // so the page-load SWR fetch is a single DB hit.
  const result = await withTenant(ctx.tenantId, async (client) => {
    const { rows: tenantRows } = await client.query<{
      id: number
      slug: string
      name: string
      type: string
      status: string
    }>(
      `SELECT id, slug, name, type, status
         FROM tenants
        WHERE id = $1 AND deleted_at IS NULL
        LIMIT 1`,
      [ctx.tenantId],
    )
    if (tenantRows.length === 0) return null

    const { rows: brandingRows } = await client.query<{
      key: string
      value: string
    }>(
      `SELECT key, value FROM tenant_config
        WHERE encrypted = false
          AND key IN ('branding_primary_color', 'branding_logo_url', 'branding_company_name')`,
    )
    const branding: Record<string, string | null> = {}
    for (const row of brandingRows) {
      try {
        branding[row.key] = JSON.parse(row.value)
      } catch {
        branding[row.key] = row.value
      }
    }

    return { tenant: tenantRows[0], branding }
  })

  if (!result) return apiError("Tenant not found", 404)

  const subscription = await loadTenantSubscription(ctx.tenantId)

  // Convert Infinity → null for JSON-safe limits per ADR-003 §Negative.
  const limits: Record<string, number | null> = {}
  for (const [key, value] of Object.entries(subscription.effectiveLimits)) {
    limits[key as LimitKey] = limitToJson(value)
  }

  return NextResponse.json({
    tenant: result.tenant,
    user: {
      id: ctx.userId,
      role: ctx.role,
      isSuperAdmin: ctx.isSuperAdmin,
    },
    subscription: {
      tier: subscription.tier,
      status: subscription.status,
      features: subscription.effectiveFeatures,
      limits,
    },
    branding: {
      primaryColor: result.branding.branding_primary_color ?? null,
      logoUrl: result.branding.branding_logo_url ?? null,
      companyName: result.branding.branding_company_name ?? null,
    },
  })
}
