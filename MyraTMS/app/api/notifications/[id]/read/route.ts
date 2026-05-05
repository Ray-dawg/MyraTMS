import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(request)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(request)
  const { id } = await params

  await withTenant(ctx.tenantId, async (client) => {
    await client.query(
      `UPDATE notifications SET read = true
        WHERE id = $1
          AND (user_id = $2 OR user_id IS NULL)`,
      [id, user.userId],
    )
  })

  return NextResponse.json({ success: true })
}
