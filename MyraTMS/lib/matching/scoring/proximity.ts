import type { PoolClient } from "@neondatabase/serverless"
import { haversine } from "../haversine"

export interface ProximityResult {
  score: number
  distanceKm: number
  driverId: string | null
  driverName: string | null
  driverPhone: string | null
  gpsConfidence: "high" | "low" | "none"
}

export async function scoreProximity(
  client: PoolClient,
  carrierId: string,
  pickupLat: number | null,
  pickupLng: number | null,
  carrierHomeLat: number | null,
  carrierHomeLng: number | null,
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

  const { rows: drivers } = await client.query(
    `SELECT id, first_name, last_name, phone, last_known_lat, last_known_lng
       FROM drivers
      WHERE carrier_id = $1
        AND status = 'available'
        AND last_known_lat IS NOT NULL
        AND last_known_lng IS NOT NULL
        AND last_ping_at > NOW() - INTERVAL '24 hours'
      LIMIT 10`,
    [carrierId],
  )

  let distanceKm: number
  let driverId: string | null = null
  let driverName: string | null = null
  let driverPhone: string | null = null
  let gpsConfidence: "high" | "low" | "none" = "none"

  if (drivers.length > 0) {
    let closest = Infinity
    for (const d of drivers) {
      const dist = haversine(
        Number(d.last_known_lat),
        Number(d.last_known_lng),
        pickupLat,
        pickupLng,
      )
      if (dist < closest) {
        closest = dist
        driverId = d.id as string
        driverName = `${d.first_name} ${(d.last_name as string || "").charAt(0)}.`
        driverPhone = (d.phone as string) || null
      }
    }
    distanceKm = closest
    gpsConfidence = "high"
  } else if (carrierHomeLat != null && carrierHomeLng != null) {
    distanceKm = haversine(carrierHomeLat, carrierHomeLng, pickupLat, pickupLng)
    gpsConfidence = "low"
  } else {
    return {
      score: 0.3,
      distanceKm: -1,
      driverId: null,
      driverName: null,
      driverPhone: null,
      gpsConfidence: "none",
    }
  }

  let score: number
  if (distanceKm <= 50) score = 1.0
  else if (distanceKm <= 500) score = 1.0 - (distanceKm - 50) / 450
  else score = 0.0

  if (gpsConfidence === "low") score = score * 0.7

  return {
    score: Math.max(0, Math.min(1.0, score)),
    distanceKm: Math.round(distanceKm),
    driverId,
    driverName,
    driverPhone,
    gpsConfidence,
  }
}
