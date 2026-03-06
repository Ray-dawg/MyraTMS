import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { getCached, setCache } from "@/lib/redis"

// ---------------------------------------------------------------------------
// GET /api/tracking/positions
// Returns fleet GPS positions. Auth-gated.
// Fallback chain:
//   1. location_pings table (from Driver_App GPS pings) — PRIMARY
//   2. Samsara ELD API (if SAMSARA_API_KEY set)
//   3. Motive ELD API (if MOTIVE_API_KEY set)
//   4. Mock data fallback
// All normalized to: { load_id, driver_name, lat, lng, speed, heading, updated_at, source }
// ---------------------------------------------------------------------------

interface NormalizedPosition {
  load_id: string
  driver_name: string
  lat: number
  lng: number
  speed: number
  heading: string
  updated_at: string
  source: string
  carrier?: string
  origin?: string
  destination?: string
  status?: string
  eta?: string
}

const MOCK_POSITIONS: NormalizedPosition[] = [
  { load_id: "LD-4821", driver_name: "Mike Wilson", lat: 37.08, lng: -94.51, speed: 62, heading: "SSW", updated_at: new Date().toISOString(), source: "mock", carrier: "Swift Logistics", origin: "Chicago, IL", destination: "Dallas, TX", status: "On Schedule", eta: "2026-02-15T22:00:00" },
  { load_id: "LD-4825", driver_name: "Carlos Ramirez", lat: 32.35, lng: -90.18, speed: 0, heading: "N", updated_at: new Date().toISOString(), source: "mock", carrier: "Roadrunner Transit", origin: "Houston, TX", destination: "Memphis, TN", status: "Delayed", eta: "2026-02-16T02:00:00" },
  { load_id: "LD-4827", driver_name: "Tom Bradley", lat: 39.55, lng: -107.32, speed: 58, heading: "W", updated_at: new Date().toISOString(), source: "mock", carrier: "Alpine Transport", origin: "Denver, CO", destination: "Salt Lake City, UT", status: "On Schedule", eta: "2026-02-15T19:30:00" },
  { load_id: "LD-4832", driver_name: "Dave Roberts", lat: 39.65, lng: -75.75, speed: 55, heading: "SW", updated_at: new Date().toISOString(), source: "mock", carrier: "Keystone Carriers", origin: "Philadelphia, PA", destination: "Baltimore, MD", status: "On Schedule", eta: "2026-02-15T15:45:00" },
]

async function fetchSamsaraPositions(apiKey: string): Promise<NormalizedPosition[]> {
  try {
    const res = await fetch("https://api.samsara.com/v1/fleet/locations", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.vehicles || data.data || []).map((v: Record<string, unknown>) => ({
      load_id: (v.loadId as string) || (v.name as string) || "Unknown",
      driver_name: (v.driverName as string) || "Unknown",
      lat: (v.latitude as number) || (v.gps as Record<string, number>)?.latitude || 0,
      lng: (v.longitude as number) || (v.gps as Record<string, number>)?.longitude || 0,
      speed: (v.speed as number) || (v.gps as Record<string, number>)?.speedMilesPerHour || 0,
      heading: (v.heading as string) || String((v.gps as Record<string, number>)?.headingDegrees || 0),
      updated_at: (v.updatedAt as string) || new Date().toISOString(),
      source: "samsara",
    }))
  } catch (err) {
    console.error("[Samsara] GPS fetch failed:", err)
    return []
  }
}

async function fetchMotivePositions(apiKey: string): Promise<NormalizedPosition[]> {
  try {
    const res = await fetch("https://api.gomotive.com/v1/vehicle_locations", {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.vehicle_locations || data.data || []).map((v: Record<string, unknown>) => ({
      load_id: (v.loadId as string) || (v.vehicle_number as string) || "Unknown",
      driver_name: (v.driver_name as string) || "Unknown",
      lat: (v.lat as number) || (v.current_location as Record<string, number>)?.lat || 0,
      lng: (v.lon as number) || (v.lng as number) || (v.current_location as Record<string, number>)?.lon || 0,
      speed: (v.speed as number) || 0,
      heading: (v.bearing as string) || (v.heading as string) || "0",
      updated_at: (v.located_at as string) || new Date().toISOString(),
      source: "motive",
    }))
  } catch (err) {
    console.error("[Motive] GPS fetch failed:", err)
    return []
  }
}

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const sql = getDb()
  const samsaraKey = process.env.SAMSARA_API_KEY
  const motiveKey = process.env.MOTIVE_API_KEY
  const apiConnected = !!(samsaraKey || motiveKey)
  const positions: NormalizedPosition[] = []
  let source = "mock"

  // 1. Try location_pings table (from Driver_App GPS pings) — PRIMARY
  try {
    const dbPositions = await sql`
      SELECT DISTINCT ON (lp.load_id)
        lp.load_id,
        d.name as driver_name,
        lp.lat,
        lp.lng,
        lp.speed,
        lp.heading,
        lp.recorded_at as updated_at,
        l.carrier,
        l.origin,
        l.destination,
        l.status,
        l.current_eta as eta
      FROM location_pings lp
      LEFT JOIN drivers d ON d.id = lp.driver_id
      LEFT JOIN loads l ON l.id = lp.load_id
      WHERE lp.recorded_at > NOW() - INTERVAL '2 hours'
      ORDER BY lp.load_id, lp.recorded_at DESC
    `

    if (dbPositions.length > 0) {
      for (const row of dbPositions) {
        positions.push({
          load_id: row.load_id,
          driver_name: row.driver_name || "Unknown",
          lat: parseFloat(row.lat),
          lng: parseFloat(row.lng),
          speed: row.speed || 0,
          heading: row.heading || "N",
          updated_at: row.updated_at || new Date().toISOString(),
          source: "driver_app",
          carrier: row.carrier,
          origin: row.origin,
          destination: row.destination,
          status: row.status,
          eta: row.eta,
        })
      }
      source = "driver_app"
    }
  } catch (err) {
    // Table may not exist yet — fall through to next source
    console.error("[GPS] location_pings query failed:", err)
  }

  // 2. If no Driver_App data, try Samsara
  if (positions.length === 0 && samsaraKey) {
    const cacheKey = "gps:samsara:positions"
    const cached = await getCached<NormalizedPosition[]>(cacheKey)
    if (cached && cached.length > 0) {
      positions.push(...cached)
      source = "samsara (cached)"
    } else {
      const samsaraPositions = await fetchSamsaraPositions(samsaraKey)
      if (samsaraPositions.length > 0) {
        positions.push(...samsaraPositions)
        source = "samsara"
        await setCache(cacheKey, samsaraPositions, 60) // Cache for 60s
      }
    }
  }

  // 3. If still no data, try Motive
  if (positions.length === 0 && motiveKey) {
    const cacheKey = "gps:motive:positions"
    const cached = await getCached<NormalizedPosition[]>(cacheKey)
    if (cached && cached.length > 0) {
      positions.push(...cached)
      source = "motive (cached)"
    } else {
      const motivePositions = await fetchMotivePositions(motiveKey)
      if (motivePositions.length > 0) {
        positions.push(...motivePositions)
        source = "motive"
        await setCache(cacheKey, motivePositions, 60) // Cache for 60s
      }
    }
  }

  // 4. Fall back to mock data
  if (positions.length === 0) {
    // Add slight randomization to simulate real-time movement
    const mocked = MOCK_POSITIONS.map((p) => ({
      ...p,
      speed: p.status === "Delayed" ? 0 : p.speed + Math.floor(Math.random() * 6) - 3,
      updated_at: new Date().toISOString(),
    }))
    positions.push(...mocked)
    source = "mock"
  }

  return NextResponse.json({
    positions,
    total: positions.length,
    source,
    api_connected: apiConnected,
    last_sync: new Date().toISOString(),
  })
}
