/**
 * DAT RateView API client.
 * Fetches lane rate data via DAT's REST API with OAuth2 authentication.
 * Caches responses in rate_cache (6-hour TTL).
 */

import type { PoolClient } from "@neondatabase/serverless"

export interface DATRateResponse {
  averageRatePerMile: number
  lowRatePerMile: number
  highRatePerMile: number
  averageTotalRate: number
  mileage: number
  reportCount: number
}

let cachedToken: { token: string; expiresAt: number } | null = null

async function getIntegrationConfig(client: PoolClient, provider: string) {
  const { rows } = await client.query(
    `SELECT * FROM integrations WHERE provider = $1 AND enabled = true LIMIT 1`,
    [provider],
  )
  return rows[0] || null
}

async function getDATAccessToken(apiKey: string, apiSecret: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token
  }

  const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")
  const res = await fetch("https://identity.api.dat.com/access/v1/token/organization", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  })

  if (!res.ok) throw new Error(`DAT auth failed: ${res.status} ${res.statusText}`)

  const data = await res.json()
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  }
  return data.access_token
}

function mapEquipmentType(type: string): string {
  const map: Record<string, string> = {
    dry_van: "V",
    reefer: "R",
    flatbed: "F",
    step_deck: "SD",
  }
  return map[type] || "V"
}

export async function fetchDATRate(
  client: PoolClient,
  originRegion: string,
  destRegion: string,
  equipmentType: string,
): Promise<DATRateResponse | null> {
  const integration = await getIntegrationConfig(client, "dat")
  if (!integration) return null

  // Check rate_cache first (6-hour TTL)
  const { rows: cached } = await client.query(
    `SELECT * FROM rate_cache
      WHERE source = 'dat'
        AND origin_region = $1 AND dest_region = $2 AND equipment_type = $3
        AND fetched_at > NOW() - INTERVAL '6 hours'
      ORDER BY fetched_at DESC LIMIT 1`,
    [originRegion, destRegion, equipmentType],
  )
  if (cached.length > 0) {
    const c = cached[0]
    const detail = c.source_detail || {}
    return {
      averageRatePerMile: Number(c.rate_per_mile),
      lowRatePerMile: Number(detail.lowRatePerMile || c.rate_per_mile * 0.85),
      highRatePerMile: Number(detail.highRatePerMile || c.rate_per_mile * 1.15),
      averageTotalRate: Number(c.total_rate || 0),
      mileage: Number(detail.mileage || 0),
      reportCount: Number(detail.reportCount || 0),
    }
  }

  try {
    const token = await getDATAccessToken(integration.api_key, integration.api_secret)

    const res = await fetch("https://freight.api.dat.com/rateview/v3/rates/lane", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: { city: originRegion },
        destination: { city: destRegion },
        equipmentType: mapEquipmentType(equipmentType),
        timePeriod: "LAST_30_DAYS",
      }),
    })

    if (!res.ok) throw new Error(`DAT API returned ${res.status}`)
    const data = await res.json()
    const rate = data.rate || data

    const result: DATRateResponse = {
      averageRatePerMile: rate.averageRatePerMile || rate.perMile?.average || 0,
      lowRatePerMile: rate.lowRatePerMile || rate.perMile?.low || 0,
      highRatePerMile: rate.highRatePerMile || rate.perMile?.high || 0,
      averageTotalRate: rate.averageTotalRate || rate.perTrip?.average || 0,
      mileage: rate.mileage || 0,
      reportCount: rate.reportCount || rate.reports || 0,
    }

    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
    await client.query(
      `INSERT INTO rate_cache (origin_region, dest_region, equipment_type, rate_per_mile, total_rate, source, source_detail, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'dat', $6, $7)`,
      [
        originRegion,
        destRegion,
        equipmentType,
        result.averageRatePerMile,
        result.averageTotalRate,
        JSON.stringify({
          lowRatePerMile: result.lowRatePerMile,
          highRatePerMile: result.highRatePerMile,
          mileage: result.mileage,
          reportCount: result.reportCount,
        }),
        expiresAt,
      ],
    )

    await client.query(`UPDATE integrations SET last_success_at = NOW() WHERE provider = 'dat'`)

    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : "DAT API error"
    console.error("[DAT client] error:", msg)
    await client.query(
      `UPDATE integrations SET last_error_at = NOW(), last_error_msg = $1 WHERE provider = 'dat'`,
      [msg],
    )
    return null
  }
}
