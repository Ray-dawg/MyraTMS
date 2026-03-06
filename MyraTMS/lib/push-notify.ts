import { getDb } from "@/lib/db"

interface PushPayload {
  title: string
  body: string
  icon?: string
  data?: Record<string, unknown>
}

export async function sendPushToDriver(driverId: string, payload: PushPayload) {
  const sql = getDb()
  const subs = await sql`SELECT * FROM push_subscriptions WHERE driver_id = ${driverId}`

  for (const sub of subs) {
    try {
      // Use web-push if available, otherwise store as pending notification
      // For MVP, create a notification in the DB that the driver can poll
      await sql`
        INSERT INTO notifications (id, user_id, title, message, type, read, created_at)
        VALUES (
          ${'NOTIF-' + Date.now().toString(36).toUpperCase()},
          ${driverId},
          ${payload.title},
          ${payload.body},
          ${'push'},
          ${false},
          NOW()
        )
      `
    } catch (err) {
      console.error('Push notification failed for subscription:', sub.endpoint, err)
    }
  }
}
