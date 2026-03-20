import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { createNotification } from "@/lib/notifications"

export async function GET(request: NextRequest) {
  const user = getCurrentUser(request)
  if (!user) return apiError("Unauthorized", 401)

  const params = request.nextUrl.searchParams
  const unreadOnly = params.get("unread_only") === "true"
  const limit = Math.min(parseInt(params.get("limit") || "50", 10) || 50, 50)

  const sql = getDb()

  const notifications = unreadOnly
    ? await sql`
        SELECT * FROM notifications
        WHERE (user_id = ${user.userId} OR user_id IS NULL)
          AND read = false
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT * FROM notifications
        WHERE (user_id = ${user.userId} OR user_id IS NULL)
        ORDER BY created_at DESC
        LIMIT ${limit}
      `

  const unreadRows = await sql`
    SELECT COUNT(*)::int AS count FROM notifications
    WHERE (user_id = ${user.userId} OR user_id IS NULL)
      AND read = false
  `

  return NextResponse.json({
    notifications,
    unreadCount: unreadRows[0].count,
  })
}

export async function POST(request: NextRequest) {
  const user = getCurrentUser(request)
  if (!user) return apiError("Unauthorized", 401)

  const body = await request.json()
  const { userId, type, title, body: notifBody, link, loadId } = body

  if (!title || !notifBody) {
    return apiError("title and body are required", 400)
  }

  const notification = await createNotification({
    userId: userId || null,
    type: type || "info",
    title,
    body: notifBody,
    link: link || null,
    loadId: loadId || null,
  })

  return NextResponse.json(notification, { status: 201 })
}
