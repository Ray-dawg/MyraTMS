import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

// POST - Subscribe a device to push notifications
// Body: { subscription: PushSubscription object, driverId: string }
export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const body = await req.json()
  const { subscription, driverId } = body

  if (!subscription || !driverId) return apiError("Missing subscription or driverId")

  const sql = getDb()
  const id = `PUSH-${Date.now().toString(36).toUpperCase()}`

  // Upsert - replace existing subscription for this driver+endpoint combo
  await sql`
    INSERT INTO push_subscriptions (id, driver_id, endpoint, p256dh, auth, created_at)
    VALUES (${id}, ${driverId}, ${subscription.endpoint}, ${subscription.keys.p256dh}, ${subscription.keys.auth}, NOW())
    ON CONFLICT (endpoint) DO UPDATE SET
      driver_id = ${driverId},
      p256dh = ${subscription.keys.p256dh},
      auth = ${subscription.keys.auth},
      created_at = NOW()
  `

  return NextResponse.json({ id, status: "subscribed" }, { status: 201 })
}

// DELETE - Unsubscribe
export async function DELETE(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const { endpoint } = await req.json()
  if (!endpoint) return apiError("Missing endpoint")

  const sql = getDb()
  await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`

  return NextResponse.json({ status: "unsubscribed" })
}
