import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function PATCH(request: NextRequest) {
  const user = getCurrentUser(request)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(request)

  await withTenant(ctx.tenantId, async (client) => {
    await client.query(
      `UPDATE notifications SET read = true
        WHERE read = false
          AND (user_id = $1 OR user_id IS NULL)`,
      [user.userId],
    )
  })

  return NextResponse.json({ success: true })
}
