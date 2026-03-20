import { getDb } from "@/lib/db"

interface CreateNotificationInput {
  userId?: string | null
  type?: string
  title: string
  body: string
  link?: string | null
  loadId?: string | null
}

export async function createNotification({
  userId = null,
  type = "info",
  title,
  body,
  link = null,
  loadId = null,
}: CreateNotificationInput) {
  const sql = getDb()
  const id = `NTF-${Date.now().toString(36).toUpperCase()}`

  const rows = await sql`
    INSERT INTO notifications (id, user_id, type, title, body, link, load_id, read, created_at)
    VALUES (${id}, ${userId}, ${type}, ${title}, ${body}, ${link}, ${loadId}, false, NOW())
    RETURNING *
  `

  return rows[0]
}
