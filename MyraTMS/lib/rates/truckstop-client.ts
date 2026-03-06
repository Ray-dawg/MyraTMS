/**
 * Truckstop Rate Analysis API client.
 * Fetches lane rate data from Truckstop's marketplace.
 * Caches responses in rate_cache (6-hour TTL).
 */

import { getDb } from "@/lib/db"

export interface TruckstopRateResponse {
  averageRate: number
  averageRatePerMile: number
  mileage: number
  loadCount: number
  trend: string
  trendPercent: number
  lowRate: number
  highRate: number
}

async function getIntegrationConfig(provider: string) {
  const sql = getDb()
  const rows = await sql`SELECT * FROM integrations WHERE provider = ${provider} AND enabled = true LIMIT 1`
  return rows[0] || null
}

function mapEquipmentType(type: string): string {
  const map: Record<string, string> = {
    dry_van: "Van",
    reefer: "Reefer",
    flatbed: "Flatbed",
    step_deck: "StepDeck",
  }
  return map[type] || "Van"
}

export async function fetchTruckstopRate(
  originRegion: string,
  destRegion: string,
  equipmentType: string
): Promise<TruckstopRateResponse | null> {
  const integration = await getIntegrationConfig("truckstop")
  if (!integration) return null

  const sql = getDb()

  // Check rate_cache first (6-hour TTL)
  const cached = await sql`
    SELECT * FROM rate_cache
    WHERE source = 'truckstop'
      AND origin_region = ${originRegion}
      AND dest_region = ${destRegion}
      AND equipment_type = ${equipmentType}
      AND fetched_at > NOW() - INTERVAL '6 hours'
    ORDER BY fetched_at DESC LIMIT 1
  `
  if (cached.length > 0) {
    const c = cached[0]
    const detail = c.source_detail || {}
    return {
      averageRate: Number(c.total_rate || 0),
      averageRatePerMile: Number(c.rate_per_mile),
      mileage: Number(detail.mileage || 0),
      loadCount: Number(detail.loadCount || 0),
      trend: String(detail.trend || "stable"),
      trendPercent: Number(detail.trendPercent || 0),
      lowRate: Number(detail.lowRate || c.rate_per_mile * 0.85),
      highRate: Number(detail.highRate || c.rate_per_mile * 1.15),
    }
  }

  try {
    const params = new URLSearchParams({
      originCity: originRegion,
      destinationCity: destRegion,
      equipmentType: mapEquipmentType(equipmentType),
      timePeriod: "30",
    })

    const res = await fetch(`https://api.truckstop.com/rates/v2/analysis?${params}`, {
      headers: {
        "Authorization": `Bearer ${integration.api_key}`,
        "Content-Type": "application/json",
      },
    })

    if (!res.ok) {
      throw new Error(`Truckstop API returned ${res.status}`)
    }

    const data = await res.json()

    const result: TruckstopRateResponse = {
      averageRate: data.averageRate || data.average?.total || 0,
      averageRatePerMile: data.averageRatePerMile || data.average?.perMile || 0,
      mileage: data.mileage || data.distance || 0,
      loadCount: data.loadCount || data.sampleSize || 0,
      trend: data.trend || "stable",
      trendPercent: data.trendPercent || 0,
      lowRate: data.lowRate || data.range?.low || 0,
      highRate: data.highRate || data.range?.high || 0,
    }

    // Cache the result
    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
    await sql`
      INSERT INTO rate_cache (origin_region, dest_region, equipment_type, rate_per_mile, total_rate, source, source_detail, expires_at)
      VALUES (${originRegion}, ${destRegion}, ${equipmentType}, ${result.averageRatePerMile}, ${result.averageRate}, 'truckstop', ${JSON.stringify({ mileage: result.mileage, loadCount: result.loadCount, trend: result.trend, trendPercent: result.trendPercent, lowRate: result.lowRate, highRate: result.highRate })}, ${expiresAt})
    `

    await sql`UPDATE integrations SET last_success_at = NOW() WHERE provider = 'truckstop'`

    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Truckstop API error"
    console.error("[Truckstop client] error:", msg)
    await sql`UPDATE integrations SET last_error_at = NOW(), last_error_msg = ${msg} WHERE provider = 'truckstop'`
    return null
  }
}
