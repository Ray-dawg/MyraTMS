import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

// NOTE: push_subscriptions table is not yet present in production schema
// (see docs/architecture/SESSION_2_SUMMARY.md §3.1). When migration 031
// adds it, RLS will auto-apply via the standard tenant_id column.

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)

  const body = await req.json()
  const { subscription, driverId } = body
  if (!subscription || !driverId) return apiError("Missing subscription or driverId")

  const id = `PUSH-${Date.now().toString(36).toUpperCase()}`
  await withTenant(ctx.tenantId, async (client) => {
    await client.query(
      `INSERT INTO push_subscriptions (id, driver_id, endpoint, p256dh, auth, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (endpoint) DO UPDATE SET
         driver_id = $2, p256dh = $4, auth = $5, created_at = NOW()`,
      [id, driverId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth],
    )
  })

  return NextResponse.json({ id, status: "subscribed" }, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)

  const { endpoint } = await req.json()
  if (!endpoint) return apiError("Missing endpoint")

  await withTenant(ctx.tenantId, async (client) => {
    await client.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint])
  })

  return NextResponse.json({ status: "unsubscribed" })
}
