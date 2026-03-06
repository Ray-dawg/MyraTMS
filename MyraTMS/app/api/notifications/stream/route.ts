import { NextRequest } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { createSSEStream, sseHeartbeat } from "@/lib/sse"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const user = getCurrentUser(request)
  if (!user) {
    return new Response("Unauthorized", { status: 401 })
  }

  const { stream, writer } = createSSEStream()

  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  }

  // Track the last notification we've seen
  let lastCheckedAt = new Date().toISOString()
  let alive = true

  // Poll for new notifications every 3 seconds
  const pollInterval = setInterval(async () => {
    if (!alive) return
    try {
      const sql = getDb()
      const rows = await sql`
        SELECT id, type, title, body, link, created_at
        FROM notifications
        WHERE created_at > ${lastCheckedAt}::timestamptz
          AND read = false
          AND (user_id = ${user.userId} OR user_id IS NULL)
        ORDER BY created_at ASC
      `

      for (const row of rows) {
        writer.write("notification", {
          id: row.id,
          type: row.type,
          title: row.title,
          body: row.body,
          link: row.link,
          createdAt: row.created_at,
        })
      }

      if (rows.length > 0) {
        lastCheckedAt = rows[rows.length - 1].created_at
      }
    } catch {
      // DB error — skip this poll cycle
    }
  }, 3000)

  // Keep-alive heartbeat every 15 seconds
  const heartbeatInterval = setInterval(() => {
    if (!alive) return
    sseHeartbeat(writer)
  }, 15000)

  // Cleanup when client disconnects
  const cleanup = () => {
    alive = false
    clearInterval(pollInterval)
    clearInterval(heartbeatInterval)
  }

  // Use the onCancel callback — createSSEStream calls it when the client disconnects
  // We need to recreate with the cleanup callback
  // Actually, the stream is already created. We'll handle cleanup via AbortSignal instead.
  request.signal.addEventListener("abort", () => {
    cleanup()
    writer.close()
  })

  return new Response(stream, { headers })
}
