import { withTenant } from "@/lib/db/tenant-context"

interface PushPayload {
  title: string
  body: string
  icon?: string
  data?: Record<string, unknown>
}

export async function sendPushToDriver(
  tenantId: number,
  driverId: string,
  payload: PushPayload,
) {
  await withTenant(tenantId, async (client) => {
    const { rows: subs } = await client.query(
      `SELECT * FROM push_subscriptions WHERE driver_id = $1`,
      [driverId],
    )

    for (const sub of subs) {
      try {
        // For MVP, create a notification in the DB that the driver can poll
        await client.query(
          `INSERT INTO notifications (id, user_id, title, body, type, read, created_at)
           VALUES ($1, $2, $3, $4, $5, false, NOW())`,
          [
            "NOTIF-" + Date.now().toString(36).toUpperCase(),
            driverId,
            payload.title,
            payload.body,
            "push",
          ],
        )
      } catch (err) {
        console.error("Push notification failed for subscription:", sub.endpoint, err)
      }
    }
  })
}
