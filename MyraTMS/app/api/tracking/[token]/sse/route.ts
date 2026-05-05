import { NextRequest } from "next/server"
import { withTenant, resolveTrackingToken } from "@/lib/db/tenant-context"

/**
 * GET /api/tracking/[token]/sse
 * Public SSE stream of position + status updates.
 * Resolves the token once at start (via resolveTrackingToken), then polls
 * inside withTenant on each tick.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const resolved = await resolveTrackingToken(token)
  if (!resolved) return new Response("Token not found", { status: 404 })
  const { tenantId, loadId } = resolved

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
          if (tickCount % 3 === 0) {
            controller.enqueue(encoder.encode(`:heartbeat\n\n`))
          }

          const load = await withTenant(tenantId, async (client) => {
            const { rows } = await client.query(
              `SELECT status, current_lat, current_lng, current_eta,
                      origin, destination, updated_at
                 FROM loads
                WHERE id = $1
                LIMIT 1`,
              [loadId],
            )
            return rows[0] ?? null
          })

          if (!load) {
            clearInterval(interval)
            try { controller.close() } catch {}
            return
          }

          const isDelivered = load.status === "delivered" || load.status === "Delivered"
          const payload = {
            status: load.status,
            currentLat: load.current_lat ? Number.parseFloat(load.current_lat) : null,
            currentLng: load.current_lng ? Number.parseFloat(load.current_lng) : null,
            currentEta: load.current_eta || null,
            lastUpdated: load.updated_at || new Date().toISOString(),
            isDelivered,
          }
          controller.enqueue(encoder.encode(`event: update\ndata: ${JSON.stringify(payload)}\n\n`))

          if (isDelivered) {
            clearInterval(interval)
            try { controller.close() } catch {}
          }
        } catch (err) {
          console.error("[SSE] Error fetching load data:", err)
        }
      }, 5000)

      try {
        const load = await withTenant(tenantId, async (client) => {
          const { rows } = await client.query(
            `SELECT status, current_lat, current_lng, current_eta,
                    origin, destination, updated_at
               FROM loads
              WHERE id = $1
              LIMIT 1`,
            [loadId],
          )
          return rows[0] ?? null
        })
        if (load) {
          const payload = {
            status: load.status,
            currentLat: load.current_lat ? Number.parseFloat(load.current_lat) : null,
            currentLng: load.current_lng ? Number.parseFloat(load.current_lng) : null,
            currentEta: load.current_eta || null,
            lastUpdated: load.updated_at || new Date().toISOString(),
            isDelivered: load.status === "delivered" || load.status === "Delivered",
          }
          controller.enqueue(encoder.encode(`event: update\ndata: ${JSON.stringify(payload)}\n\n`))
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
