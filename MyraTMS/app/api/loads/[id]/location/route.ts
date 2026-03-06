import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { calculateETA, checkExceptions } from "@/lib/eta"

/**
 * POST /api/loads/[id]/location
 * GPS ping ingestion from driver app.
 * Auth-gated (driver JWT from driver-login).
 *
 * Body: { lat: number, lng: number, speed?: number, heading?: number }
 *
 * On each ping:
 * 1. INSERT into location_pings
 * 2. UPDATE loads current_lat/lng/updated_at
 * 3. Calculate ETA → UPDATE loads current_eta
 * 4. Check exceptions → INSERT notifications if triggered
 * 5. UPDATE drivers last_known_lat/lng/last_ping_at
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getCurrentUser(request)
  if (!user) {
    return apiError("Unauthorized", 401)
  }

  const { id } = await params
  const body = await request.json()

  const { lat, lng, speed, heading } = body

  if (lat == null || lng == null) {
    return apiError("lat and lng are required", 400)
  }

  const sql = getDb()

  // Verify load exists and get destination coords
  const loads = await sql`
    SELECT id, dest_lat, dest_lng, delivery_date, status, origin_lat, origin_lng, updated_at
    FROM loads
    WHERE id = ${id}
    LIMIT 1
  `

  if (loads.length === 0) {
    return apiError("Load not found", 404)
  }

  const load = loads[0]
  const driverId = user.userId
  const pingId = crypto.randomUUID()

  // 1. INSERT into location_pings
  await sql`
    INSERT INTO location_pings (id, load_id, driver_id, lat, lng, speed_mph, heading)
    VALUES (${pingId}, ${id}, ${driverId}, ${lat}, ${lng}, ${speed || null}, ${heading || null})
  `

  // 2 & 3. Calculate ETA if destination coords are available
  let etaIso: string | null = null
  if (load.dest_lat && load.dest_lng) {
    const destLat = parseFloat(load.dest_lat)
    const destLng = parseFloat(load.dest_lng)
    const avgSpeed = speed && speed > 5 ? speed : 55
    const etaResult = calculateETA(lat, lng, destLat, destLng, avgSpeed)
    etaIso = etaResult.estimatedArrival.toISOString()

    // UPDATE loads with position + ETA
    await sql`
      UPDATE loads
      SET current_lat = ${lat},
          current_lng = ${lng},
          current_eta = ${etaIso},
          updated_at = now()
      WHERE id = ${id}
    `

    // 4. Check exceptions
    const exceptions = checkExceptions(
      {
        delivery_date: load.delivery_date,
        updated_at: load.updated_at,
        status: load.status,
        current_lat: lat,
        current_lng: lng,
        origin_lat: load.origin_lat ? parseFloat(load.origin_lat) : null,
        origin_lng: load.origin_lng ? parseFloat(load.origin_lng) : null,
      },
      etaResult.estimatedArrival
    )

    // Insert notifications for each exception
    for (const exc of exceptions) {
      const notifId = crypto.randomUUID()
      await sql`
        INSERT INTO notifications (id, user_id, title, message, type, metadata)
        SELECT ${notifId}, u.id, ${`Load ${id}: ${exc.type}`}, ${exc.message},
               ${exc.severity === "critical" ? "error" : "warning"},
               ${JSON.stringify({ loadId: id, exceptionType: exc.type })}
        FROM users u
        WHERE u.role IN ('admin', 'ops')
        LIMIT 1
      `
    }
  } else {
    // No destination coords — just update position
    await sql`
      UPDATE loads
      SET current_lat = ${lat},
          current_lng = ${lng},
          updated_at = now()
      WHERE id = ${id}
    `
  }

  // 5. UPDATE drivers last known position
  try {
    await sql`
      UPDATE drivers
      SET last_known_lat = ${lat},
          last_known_lng = ${lng},
          last_ping_at = now()
      WHERE id = ${driverId}
    `
  } catch {
    // Driver may not exist in drivers table if using a regular user token
    // This is non-critical, so we swallow the error
  }

  return NextResponse.json({
    success: true,
    eta: etaIso,
  })
}
