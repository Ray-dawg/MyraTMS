/**
 * Distance service — geocodes addresses and calculates driving distance.
 * Uses Mapbox APIs when available, haversine fallback otherwise.
 *
 * NOTE: distance_cache is a global (non-tenant-scoped) cache table — see
 * migration 029 which intentionally omits it from RLS coverage. Internally
 * uses withTenant for connection acquisition only.
 */

import { withTenant } from "@/lib/db/tenant-context"
import { LEGACY_DEFAULT_TENANT_ID } from "@/lib/auth"
import crypto from "crypto"

export interface DistanceResult {
  distanceKm: number
  distanceMiles: number
  driveTimeHours: number
  originLat: number
  originLng: number
  destLat: number
  destLng: number
  fromCache: boolean
}

function hashAddress(address: string): string {
  return crypto.createHash("md5").update(address.trim().toLowerCase()).digest("hex")
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number }> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
  if (!token) {
    throw new Error("MAPBOX_TOKEN not configured — cannot geocode address")
  }
  const encoded = encodeURIComponent(address.trim())
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?access_token=${token}&limit=1&country=ca,us`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`)
  const data = await res.json()
  if (!data.features || data.features.length === 0) {
    throw new Error(`No geocoding results for: ${address}`)
  }
  const [lng, lat] = data.features[0].center
  return { lat, lng }
}

async function getDirectionsDistance(
  lat1: number, lng1: number, lat2: number, lng2: number,
): Promise<{ distanceKm: number; driveTimeHours: number } | null> {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN
  if (!token) return null
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${lng1},${lat1};${lng2},${lat2}?access_token=${token}&overview=false`
  const res = await fetch(url)
  if (!res.ok) return null
  const data = await res.json()
  if (!data.routes || data.routes.length === 0) return null
  const route = data.routes[0]
  return {
    distanceKm: route.distance / 1000,
    driveTimeHours: route.duration / 3600,
  }
}

export async function getDistance(originAddress: string, destAddress: string): Promise<DistanceResult> {
  const originHash = hashAddress(originAddress)
  const destHash = hashAddress(destAddress)

  // Cache lookup (global table)
  const cached = await withTenant(LEGACY_DEFAULT_TENANT_ID, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM distance_cache
        WHERE origin_hash = $1 AND dest_hash = $2
          AND created_at > NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC LIMIT 1`,
      [originHash, destHash],
    )
    return rows
  })

  if (cached.length > 0) {
    const row = cached[0]
    return {
      distanceKm: Number(row.distance_km),
      distanceMiles: Number(row.distance_miles),
      driveTimeHours: Number(row.drive_time_hours),
      originLat: Number(row.origin_lat),
      originLng: Number(row.origin_lng),
      destLat: Number(row.dest_lat),
      destLng: Number(row.dest_lng),
      fromCache: true,
    }
  }

  let originCoords: { lat: number; lng: number }
  let destCoords: { lat: number; lng: number }
  try {
    originCoords = await geocodeAddress(originAddress)
    destCoords = await geocodeAddress(destAddress)
  } catch {
    throw new Error(
      "Unable to geocode addresses. Ensure NEXT_PUBLIC_MAPBOX_TOKEN is configured or provide lat/lng coordinates.",
    )
  }

  const directions = await getDirectionsDistance(
    originCoords.lat, originCoords.lng, destCoords.lat, destCoords.lng,
  )

  let distanceKm: number
  let driveTimeHours: number
  if (directions) {
    distanceKm = directions.distanceKm
    driveTimeHours = directions.driveTimeHours
  } else {
    const straight = haversineKm(originCoords.lat, originCoords.lng, destCoords.lat, destCoords.lng)
    distanceKm = straight * 1.3
    driveTimeHours = distanceKm / 85
  }

  const distanceMiles = distanceKm * 0.621371

  await withTenant(LEGACY_DEFAULT_TENANT_ID, async (client) => {
    await client.query(
      `INSERT INTO distance_cache (
         origin_hash, dest_hash, origin_address, dest_address,
         distance_km, distance_miles, drive_time_hours,
         origin_lat, origin_lng, dest_lat, dest_lng
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       )`,
      [
        originHash, destHash, originAddress, destAddress,
        distanceKm, distanceMiles, driveTimeHours,
        originCoords.lat, originCoords.lng, destCoords.lat, destCoords.lng,
      ],
    )
  })

  return {
    distanceKm,
    distanceMiles,
    driveTimeHours,
    originLat: originCoords.lat,
    originLng: originCoords.lng,
    destLat: destCoords.lat,
    destLng: destCoords.lng,
    fromCache: false,
  }
}

export async function getDistanceFromCoords(
  originLat: number, originLng: number,
  destLat: number, destLng: number,
): Promise<Omit<DistanceResult, "fromCache">> {
  const directions = await getDirectionsDistance(originLat, originLng, destLat, destLng)

  let distanceKm: number
  let driveTimeHours: number
  if (directions) {
    distanceKm = directions.distanceKm
    driveTimeHours = directions.driveTimeHours
  } else {
    const straight = haversineKm(originLat, originLng, destLat, destLng)
    distanceKm = straight * 1.3
    driveTimeHours = distanceKm / 85
  }

  return {
    distanceKm,
    distanceMiles: distanceKm * 0.621371,
    driveTimeHours,
    originLat,
    originLng,
    destLat,
    destLng,
  }
}
