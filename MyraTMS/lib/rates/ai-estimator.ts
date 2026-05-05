/**
 * AI-powered rate estimation -- Source 5 in the cascade.
 * Uses Vercel AI SDK with xai/grok-3-mini-fast.
 * Caches results in rate_cache (24-hour TTL).
 */

import { generateText } from "ai"
import type { PoolClient } from "@neondatabase/serverless"
import { getLatestFuelPrice } from "./fuel-index"

const SYSTEM_PROMPT = `You are a freight rate analyst for a Canadian truckload brokerage operating primarily in Ontario. You provide rate estimates based on the data provided. Respond ONLY with a JSON object matching this schema:
{
  "ratePerMile": number,
  "totalRate": number,
  "rangeLow": number,
  "rangeHigh": number,
  "reasoning": string
}
No explanation outside the JSON. All rates in CAD.`

function buildUserPrompt(params: {
  originCity: string
  destCity: string
  distanceMiles: number
  distanceKm: number
  equipmentType: string
  dieselPrice: number
  nearbyLanes: { origin_region: string; dest_region: string; rate_per_mile: number; source: string }[]
  season: string
  dayType: string
}): string {
  const laneContext = params.nearbyLanes.length > 0
    ? params.nearbyLanes.map((l) => `  ${l.origin_region} -> ${l.dest_region}: ${l.rate_per_mile}/mi (${l.source})`).join("\n")
    : "  No nearby lane data available"

  return `Estimate the carrier cost for this shipment:

Lane: ${params.originCity} -> ${params.destCity}
Distance: ${params.distanceMiles.toFixed(0)} miles / ${params.distanceKm.toFixed(0)} km
Equipment: ${params.equipmentType}
Current Diesel: ${params.dieselPrice.toFixed(2)} CAD/litre
Season: ${params.season}
Day Type: ${params.dayType}

Nearby lane rates for context:
${laneContext}

Provide your best estimate as a JSON object.`
}

function getSeason(date: Date): string {
  const month = date.getMonth()
  if (month >= 2 && month <= 4) return "spring"
  if (month >= 5 && month <= 7) return "summer"
  if (month >= 8 && month <= 10) return "fall"
  return "winter"
}

function deriveConfidenceFromRange(rangeLow: number, rangeHigh: number, hasNearbyLanes: boolean): number {
  if (rangeHigh <= 0 || rangeLow <= 0) return 0.50
  const spreadRatio = (rangeHigh - rangeLow) / rangeHigh
  const fromSpread = Math.max(0.40, 0.70 - spreadRatio * 0.75)
  const bonus = hasNearbyLanes ? 0.05 : 0
  return Math.min(0.75, fromSpread + bonus)
}

export interface AIRateResult {
  ratePerMile: number
  totalRate: number
  confidence: number
  reasoning: string
  rangeLow: number
  rangeHigh: number
}

export async function estimateRateWithAI(
  client: PoolClient,
  originRegion: string,
  destRegion: string,
  equipmentType: string,
  distanceMiles: number,
  distanceKm: number,
  pickupDate: Date,
): Promise<AIRateResult | null> {
  const { rows: integration } = await client.query(
    `SELECT * FROM integrations WHERE provider = 'ai' AND enabled = true LIMIT 1`,
  )
  if (!integration[0]) return null

  const { rows: cached } = await client.query(
    `SELECT * FROM rate_cache
      WHERE source = 'ai'
        AND origin_region = $1 AND dest_region = $2 AND equipment_type = $3
        AND fetched_at > NOW() - INTERVAL '24 hours'
      ORDER BY fetched_at DESC LIMIT 1`,
    [originRegion, destRegion, equipmentType],
  )
  if (cached.length > 0) {
    const c = cached[0]
    const detail = c.source_detail || {}
    const rangeLow = Number(detail.rangeLow || c.rate_per_mile * 0.85 * distanceMiles)
    const rangeHigh = Number(detail.rangeHigh || c.rate_per_mile * 1.15 * distanceMiles)
    return {
      ratePerMile: Number(c.rate_per_mile),
      totalRate: Number(c.total_rate || c.rate_per_mile * distanceMiles),
      confidence: deriveConfidenceFromRange(rangeLow, rangeHigh, Boolean(detail.hadNearbyLanes)),
      reasoning: String(detail.reasoning || "Cached AI estimate"),
      rangeLow,
      rangeHigh,
    }
  }

  try {
    const { rows: nearbyLanes } = await client.query(
      `SELECT origin_region, dest_region, rate_per_mile, source
         FROM rate_cache
        WHERE source != 'ai' AND rate_per_mile IS NOT NULL AND rate_per_mile > 0
        ORDER BY fetched_at DESC LIMIT 5`,
    )
    const fuel = await getLatestFuelPrice(client)
    const now = new Date()
    const dayType = [0, 6].includes(now.getDay()) ? "weekend" : "weekday"
    const hasNearbyLanes = nearbyLanes.length > 0

    const userPrompt = buildUserPrompt({
      originCity: originRegion,
      destCity: destRegion,
      distanceMiles,
      distanceKm,
      equipmentType,
      dieselPrice: fuel.pricePerLitre,
      nearbyLanes: nearbyLanes.map((l: Record<string, unknown>) => ({
        origin_region: String(l.origin_region),
        dest_region: String(l.dest_region),
        rate_per_mile: Number(l.rate_per_mile),
        source: String(l.source),
      })),
      season: getSeason(pickupDate),
      dayType,
    })

    const { text } = await generateText({
      model: "xai/grok-3-mini-fast",
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      temperature: 0.3,
      maxOutputTokens: 500,
    })

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error("AI did not return valid JSON")

    const parsed = JSON.parse(jsonMatch[0])
    if (!parsed.ratePerMile || typeof parsed.ratePerMile !== "number") {
      throw new Error("AI response missing ratePerMile")
    }

    const rangeLow: number = parsed.rangeLow || parsed.ratePerMile * 0.85 * distanceMiles
    const rangeHigh: number = parsed.rangeHigh || parsed.ratePerMile * 1.15 * distanceMiles

    const result: AIRateResult = {
      ratePerMile: parsed.ratePerMile,
      totalRate: parsed.totalRate || parsed.ratePerMile * distanceMiles,
      confidence: deriveConfidenceFromRange(rangeLow, rangeHigh, hasNearbyLanes),
      reasoning: parsed.reasoning || "AI estimation",
      rangeLow,
      rangeHigh,
    }

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await client.query(
      `INSERT INTO rate_cache (origin_region, dest_region, equipment_type, rate_per_mile, total_rate, source, source_detail, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'ai', $6, $7)`,
      [
        originRegion,
        destRegion,
        equipmentType,
        result.ratePerMile,
        result.totalRate,
        JSON.stringify({
          reasoning: result.reasoning,
          rangeLow: result.rangeLow,
          rangeHigh: result.rangeHigh,
          hadNearbyLanes: hasNearbyLanes,
        }),
        expiresAt,
      ],
    )

    await client.query(`UPDATE integrations SET last_success_at = NOW() WHERE provider = 'ai'`)

    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI estimation error"
    console.error("[AI estimator] error:", msg)
    await client.query(
      `UPDATE integrations SET last_error_at = NOW(), last_error_msg = $1 WHERE provider = 'ai'`,
      [msg],
    )
    return null
  }
}
