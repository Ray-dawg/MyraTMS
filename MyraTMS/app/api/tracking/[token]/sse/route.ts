import { NextRequest } from "next/server"
import { getDb } from "@/lib/db"

/**
 * GET /api/tracking/[token]/sse
 * Public SSE stream. Sends 'update' events every 5 seconds with
 * current position + status. Closes when load is delivered.
 * Sends heartbeat comments every 15 seconds.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const sql = getDb()

  // Validate token
  const tokens = await sql`
    SELECT load_id, expires_at FROM tracking_tokens
    WHERE token = ${token}
    LIMIT 1
  `

  if (tokens.length === 0) {
    return new Response("Token not found", { status: 404 })
  }

  const { load_id, expires_at } = tokens[0]

  if (expires_at && new Date(expires_at) < new Date()) {
    return new Response("Token expired", { status: 410 })
  }

  const encoder = new TextEncoder()
  let cancelled = false

  const stream = new ReadableStream({
    async start(controller) {
      let tickCount = 0

      const interval = setInterval(async () => {
        if (cancelled) {
          clearInterval(interval)
          return
        }

        tickCount++

        try {
          // Every 15s (every 3rd tick) send a heartbeat
          if (tickCount % 3 === 0) {
            controller.enqueue(encoder.encode(`:heartbeat\n\n`))
          }

          // Fetch current load state
          const rows = await sql`
            SELECT
              status, current_lat, current_lng, current_eta,
              origin, destination, updated_at
            FROM loads
            WHERE id = ${load_id}
            LIMIT 1
          `

          if (rows.length === 0) {
            clearInterval(interval)
            try { controller.close() } catch { /* noop */ }
            return
          }

          const load = rows[0]
          const isDelivered = load.status === "delivered" || load.status === "Delivered"

          const payload = {
            status: load.status,
            currentLat: load.current_lat ? parseFloat(load.current_lat) : null,
            currentLng: load.current_lng ? parseFloat(load.current_lng) : null,
            currentEta: load.current_eta || null,
            lastUpdated: load.updated_at || new Date().toISOString(),
            isDelivered,
          }

          const data = `event: update\ndata: ${JSON.stringify(payload)}\n\n`
          controller.enqueue(encoder.encode(data))

          // Close stream when delivered
          if (isDelivered) {
            clearInterval(interval)
            try { controller.close() } catch { /* noop */ }
          }
        } catch (err) {
          console.error("[SSE] Error fetching load data:", err)
          // Don't close on transient errors; just skip this tick
        }
      }, 5000) // 5 second interval

      // Send an initial update immediately
      try {
        const rows = await sql`
          SELECT
            status, current_lat, current_lng, current_eta,
            origin, destination, updated_at
          FROM loads
          WHERE id = ${load_id}
          LIMIT 1
        `

        if (rows.length > 0) {
          const load = rows[0]
          const payload = {
            status: load.status,
            currentLat: load.current_lat ? parseFloat(load.current_lat) : null,
            currentLng: load.current_lng ? parseFloat(load.current_lng) : null,
            currentEta: load.current_eta || null,
            lastUpdated: load.updated_at || new Date().toISOString(),
            isDelivered: load.status === "delivered" || load.status === "Delivered",
          }
          const data = `event: update\ndata: ${JSON.stringify(payload)}\n\n`
          controller.enqueue(encoder.encode(data))
        }
      } catch {
        // initial send failed; interval will retry
      }
    },
    cancel() {
      cancelled = true
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
