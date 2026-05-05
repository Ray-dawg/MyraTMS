import { withTenant } from "@/lib/db/tenant-context"

interface CreateNotificationInput {
  tenantId: number
  userId?: string | null
  type?: string
  title: string
  body: string
  link?: string | null
  loadId?: string | null
}

export async function createNotification({
  tenantId,
  userId = null,
  type = "info",
  title,
  body,
  link = null,
  loadId = null,
}: CreateNotificationInput) {
  const id = `NTF-${Date.now().toString(36).toUpperCase()}`

  const row = await withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO notifications (id, user_id, type, title, body, link, load_id, read, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, NOW())
       RETURNING *`,
      [id, userId, type, title, body, link, loadId],
    )
    return rows[0]
  })

  return row
}
