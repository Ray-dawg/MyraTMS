import crypto from "crypto"
import { getDb } from "@/lib/db"
import { normalizeRegion } from "./region-mapper"

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN

export interface GeoPoint {
  lat: number
  lng: number
  address: string
}

export interface DistanceResult {
  distanceKm: number
  distanceMiles: number
  driveTimeHours: number
  originLat: number
  originLng: number
  originRegion: string
  destLat: number
  destLng: number
  destRegion: string
}

function hashCoords(lat: number, lng: number): string {
  return crypto
    .createHash("sha256")
    .update(`${lat.toFixed(4)},${lng.toFixed(4)}`)
    .digest("hex")
    .slice(0, 64)
}

export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number }> {
  if (!MAPBOX_TOKEN) {
    throw new Error("Mapbox token not configured — cannot geocode")
  }
  const encoded = encodeURIComponent(address)
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?country=CA,US&limit=1&access_token=${MAPBOX_TOKEN}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`)
  const data = await res.json()
  if (!data.features?.length) throw new Error(`No geocoding results for: ${address}`)
  const [lng, lat] = data.features[0].center
  return { lat, lng }
}

export async function getDrivingDistance(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number,
  originAddress: string,
  destAddress: string
): Promise<DistanceResult> {
  const originHash = hashCoords(originLat, originLng)
  const destHash = hashCoords(destLat, destLng)
  const sql = getDb()

  // Check cache (valid for 30 days)
  const cached = await sql`
    SELECT * FROM distance_cache
    WHERE origin_hash = ${originHash} AND dest_hash = ${destHash}
      AND created_at > NOW() - INTERVAL '30 days'
    LIMIT 1
  `
  if (cached.length > 0) {
    const c = cached[0]
    return {
      distanceKm: Number(c.distance_km),
      distanceMiles: Number(c.distance_miles),
      driveTimeHours: Number(c.drive_time_hours),
      originLat,
      originLng,
      originRegion: normalizeRegion(originLat, originLng),
      destLat,
      destLng,
      destRegion: normalizeRegion(destLat, destLng),
    }
  }

  // Mapbox Directions API
  if (!MAPBOX_TOKEN) {
    // Fallback: haversine straight-line × 1.25 factor
    const R = 6371
    const dLat = ((destLat - originLat) * Math.PI) / 180
    const dLng = ((destLng - originLng) * Math.PI) / 180
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((originLat * Math.PI) / 180) *
        Math.cos((destLat * Math.PI) / 180) *
        Math.sin(dLng / 2) ** 2
    const straightKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    const distanceKm = straightKm * 1.25
    const distanceMiles = distanceKm * 0.621371
    return {
      distanceKm: Math.round(distanceKm * 10) / 10,
      distanceMiles: Math.round(distanceMiles * 10) / 10,
      driveTimeHours: Math.round((distanceKm / 90) * 10) / 10,
      originLat,
      originLng,
      originRegion: normalizeRegion(originLat, originLng),
      destLat,
      destLng,
      destRegion: normalizeRegion(destLat, destLng),
    }
  }

  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${originLng},${originLat};${destLng},${destLat}?access_token=${MAPBOX_TOKEN}&overview=full&geometries=geojson`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Mapbox Directions failed: ${res.status}`)
  const data = await res.json()
  const route = data.routes?.[0]
  if (!route) throw new Error("No route found")

  const distanceKm = Math.round((route.distance / 1000) * 10) / 10
  const distanceMiles = Math.round(distanceKm * 0.621371 * 10) / 10
  const driveTimeHours = Math.round((route.duration / 3600) * 10) / 10

  // Store in cache
  await sql`
    INSERT INTO distance_cache (origin_hash, dest_hash, origin_address, dest_address,
      distance_km, distance_miles, drive_time_hours, route_geometry)
    VALUES (
      ${originHash}, ${destHash}, ${originAddress}, ${destAddress},
      ${distanceKm}, ${distanceMiles}, ${driveTimeHours},
      ${JSON.stringify(route.geometry)}
    )
    ON CONFLICT DO NOTHING
  `

  return {
    distanceKm,
    distanceMiles,
    driveTimeHours,
    originLat,
    originLng,
    originRegion: normalizeRegion(originLat, originLng),
    destLat,
    destLng,
    destRegion: normalizeRegion(destLat, destLng),
  }
}

export async function resolveAddressToDistance(
  originAddress: string,
  destAddress: string
): Promise<DistanceResult> {
  const [origin, dest] = await Promise.all([
    geocodeAddress(originAddress),
    geocodeAddress(destAddress),
  ])
  return getDrivingDistance(
    origin.lat, origin.lng,
    dest.lat, dest.lng,
    originAddress, destAddress
  )
}
