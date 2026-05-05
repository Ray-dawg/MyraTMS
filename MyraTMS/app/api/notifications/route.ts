import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { createNotification } from "@/lib/notifications"

export async function GET(request: NextRequest) {
  const user = getCurrentUser(request)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(request)

  const params = request.nextUrl.searchParams
  const unreadOnly = params.get("unread_only") === "true"
  const limit = Math.min(Number.parseInt(params.get("limit") || "50", 10) || 50, 50)

  const result = await withTenant(ctx.tenantId, async (client) => {
    const notifications = unreadOnly
      ? (await client.query(
          `SELECT * FROM notifications
            WHERE (user_id = $1 OR user_id IS NULL)
              AND read = false
            ORDER BY created_at DESC
            LIMIT $2`,
          [user.userId, limit],
        )).rows
      : (await client.query(
          `SELECT * FROM notifications
            WHERE (user_id = $1 OR user_id IS NULL)
            ORDER BY created_at DESC
            LIMIT $2`,
          [user.userId, limit],
        )).rows

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS count FROM notifications
        WHERE (user_id = $1 OR user_id IS NULL)
          AND read = false`,
      [user.userId],
    )

    return { notifications, unreadCount: countRows[0].count as number }
  })

  return NextResponse.json(result)
}

export async function POST(request: NextRequest) {
  const user = getCurrentUser(request)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(request)

  const body = await request.json()
  const { userId, type, title, body: notifBody, link, loadId } = body

  if (!title || !notifBody) {
    return apiError("title and body are required", 400)
  }

  const notification = await createNotification({
    tenantId: ctx.tenantId,
    userId: userId || null,
    type: type || "info",
    title,
    body: notifBody,
    link: link || null,
    loadId: loadId || null,
  })

  return NextResponse.json(notification, { status: 201 })
}
