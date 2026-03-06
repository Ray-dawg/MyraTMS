import type { NeonQueryFunction } from "@neondatabase/serverless"
import { haversine } from "../haversine"

export interface ProximityResult {
  score: number
  distanceKm: number
  driverId: string | null
  driverName: string | null
  driverPhone: string | null
  gpsConfidence: "high" | "low" | "none"
}

/**
 * Proximity to Pickup Score (Weight: 0.25)
 * Measures how close the carrier's nearest available driver is to the pickup.
 * Falls back to carrier home base if no driver GPS data.
 */
export async function scoreProximity(
  sql: NeonQueryFunction<false, false>,
  carrierId: string,
  pickupLat: number | null,
  pickupLng: number | null,
  carrierHomeLat: number | null,
  carrierHomeLng: number | null
): Promise<ProximityResult> {
  if (pickupLat == null || pickupLng == null) {
    return {
      score: 0.5,
      distanceKm: -1,
      driverId: null,
      driverName: null,
      driverPhone: null,
      gpsConfidence: "none",
    }
  }

  // Try to find nearest available driver with recent GPS
  const drivers = await sql`
    SELECT id, first_name, last_name, phone,
           last_known_lat, last_known_lng
    FROM drivers
    WHERE carrier_id = ${carrierId}
      AND status = 'available'
      AND last_known_lat IS NOT NULL
      AND last_known_lng IS NOT NULL
      AND last_ping_at > NOW() - INTERVAL '24 hours'
    LIMIT 10
  `

  let distanceKm: number
  let driverId: string | null = null
  let driverName: string | null = null
  let driverPhone: string | null = null
  let gpsConfidence: "high" | "low" | "none" = "none"

  if (drivers.length > 0) {
    // Find closest driver
    let closest = Infinity
    for (const d of drivers) {
      const dist = haversine(
        Number(d.last_known_lat),
        Number(d.last_known_lng),
        pickupLat,
        pickupLng
      )
      if (dist < closest) {
        closest = dist
        driverId = d.id as string
        driverName = `${d.first_name} ${(d.last_name as string || "").charAt(0)}.`
        driverPhone = d.phone as string || null
      }
    }
    distanceKm = closest
    gpsConfidence = "high"
  } else if (carrierHomeLat != null && carrierHomeLng != null) {
    // Fall back to carrier home base
    distanceKm = haversine(carrierHomeLat, carrierHomeLng, pickupLat, pickupLng)
    gpsConfidence = "low"
  } else {
    // No location data at all
    return {
      score: 0.3,
      distanceKm: -1,
      driverId: null,
      driverName: null,
      driverPhone: null,
      gpsConfidence: "none",
    }
  }

  // Score: inversely proportional to distance
  // Under 50km = perfect, degrades linearly to 500km = 0
  let score: number
  if (distanceKm <= 50) score = 1.0
  else if (distanceKm <= 500) score = 1.0 - (distanceKm - 50) / 450
  else score = 0.0

  // Reduce score if using carrier home base instead of live GPS
  if (gpsConfidence === "low") {
    score = score * 0.7
  }

  return {
    score: Math.max(0, Math.min(1.0, score)),
    distanceKm: Math.round(distanceKm),
    driverId,
    driverName,
    driverPhone,
    gpsConfidence,
  }
}
