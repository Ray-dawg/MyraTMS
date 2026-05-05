import { NextRequest } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { createSSEStream, sseHeartbeat } from "@/lib/sse"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const user = getCurrentUser(request)
  if (!user) return new Response("Unauthorized", { status: 401 })
  const ctx = requireTenantContext(request)

  const { stream, writer } = createSSEStream()

  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  }

  let lastCheckedAt = new Date().toISOString()
  let alive = true

  const pollInterval = setInterval(async () => {
    if (!alive) return
    try {
      const rows = await withTenant(ctx.tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT id, type, title, body, link, created_at
             FROM notifications
            WHERE created_at > $1::timestamptz
              AND read = false
              AND (user_id = $2 OR user_id IS NULL)
            ORDER BY created_at ASC`,
          [lastCheckedAt, user.userId],
        )
        return rows
      })

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

  const heartbeatInterval = setInterval(() => {
    if (!alive) return
    sseHeartbeat(writer)
  }, 15000)

  const cleanup = () => {
    alive = false
    clearInterval(pollInterval)
    clearInterval(heartbeatInterval)
  }

  request.signal.addEventListener("abort", () => {
    cleanup()
    writer.close()
  })

  return new Response(stream, { headers })
}
