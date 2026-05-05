import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { calculateETA, checkExceptions } from "@/lib/eta"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getCurrentUser(request)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(request)

  const { id } = await params
  const body = await request.json()
  const { lat, lng, speed, heading } = body

  if (lat == null || lng == null) return apiError("lat and lng are required", 400)

  const result = await withTenant(ctx.tenantId, async (client) => {
    const { rows: loads } = await client.query(
      `SELECT id, driver_id, dest_lat, dest_lng, delivery_date, status,
              origin_lat, origin_lng, updated_at
         FROM loads WHERE id = $1 LIMIT 1`,
      [id],
    )
    if (loads.length === 0) return { notFound: true as const }
    const load = loads[0]

    if (user.role === "driver" && load.driver_id !== user.userId) {
      return { forbidden: true as const }
    }

    const driverId = user.userId
    const pingId = crypto.randomUUID()

    await client.query(
      `INSERT INTO location_pings (id, load_id, driver_id, lat, lng, speed_mph, heading)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [pingId, id, driverId, lat, lng, speed || null, heading || null],
    )

    let etaIso: string | null = null
    if (load.dest_lat && load.dest_lng) {
      const destLat = Number.parseFloat(load.dest_lat)
      const destLng = Number.parseFloat(load.dest_lng)
      const avgSpeed = speed && speed > 5 ? speed : 55
      const etaResult = calculateETA(lat, lng, destLat, destLng, avgSpeed)
      etaIso = etaResult.estimatedArrival.toISOString()

      await client.query(
        `UPDATE loads
            SET current_lat = $1, current_lng = $2, current_eta = $3, updated_at = now()
          WHERE id = $4`,
        [lat, lng, etaIso, id],
      )

      const exceptions = checkExceptions(
        {
          delivery_date: load.delivery_date,
          updated_at: load.updated_at,
          status: load.status,
          current_lat: lat,
          current_lng: lng,
          origin_lat: load.origin_lat ? Number.parseFloat(load.origin_lat) : null,
          origin_lng: load.origin_lng ? Number.parseFloat(load.origin_lng) : null,
        },
        etaResult.estimatedArrival,
      )

      for (const exc of exceptions) {
        const notifId = crypto.randomUUID()
        await client.query(
          `INSERT INTO notifications (id, user_id, title, body, type, metadata)
           SELECT $1, u.id, $2, $3, $4, $5::jsonb
             FROM users u WHERE u.role IN ('admin', 'ops') LIMIT 1`,
          [
            notifId,
            `Load ${id}: ${exc.type}`,
            exc.message,
            exc.severity === "critical" ? "error" : "warning",
            JSON.stringify({ loadId: id, exceptionType: exc.type }),
          ],
        )
      }
    } else {
      await client.query(
        `UPDATE loads SET current_lat = $1, current_lng = $2, updated_at = now() WHERE id = $3`,
        [lat, lng, id],
      )
    }

    try {
      await client.query(
        `UPDATE drivers
            SET last_known_lat = $1, last_known_lng = $2, last_ping_at = now()
          WHERE id = $3`,
        [lat, lng, driverId],
      )
    } catch {
      // Driver may not exist in drivers table if using a regular user token
    }

    return { eta: etaIso }
  })

  if ("notFound" in result) return apiError("Load not found", 404)
  if ("forbidden" in result) return apiError("Forbidden", 403)
  return NextResponse.json({ success: true, eta: result.eta })
}
