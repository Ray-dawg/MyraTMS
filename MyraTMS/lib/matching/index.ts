import { withTenant } from "@/lib/db/tenant-context"
import type { PoolClient } from "@neondatabase/serverless"
import { getEligibleCarriers } from "./filters"
import {
  scoreLaneFamiliarity,
  scoreProximity,
  scoreRate,
  scoreReliability,
  scoreRelationship,
} from "./scoring"
import { scoreToGrade, gradeToMinScore, type MatchGrade } from "./grades"
import { kmToMiles } from "./haversine"

// ── Types ────────────────────────────────────────────────────────

export interface ScoreBreakdown {
  lane_familiarity: { score: number; weight: number; loads_on_lane: number }
  proximity: {
    score: number
    weight: number
    distance_km: number
    driver_id: string | null
    gps_confidence: string
  }
  rate: { score: number; weight: number; carrier_avg_rate: number | null }
  reliability: {
    score: number
    weight: number
    on_time_pct: number | null
    total_loads: number
  }
  relationship: { score: number; weight: number; days_since_last: number | null }
}

export interface CarrierMatch {
  rank: number
  carrier_id: string
  carrier_name: string
  match_score: number
  match_grade: MatchGrade
  breakdown: ScoreBreakdown
  suggested_driver: {
    id: string | null
    name: string | null
    phone: string | null
  } | null
  contact: {
    name: string
    phone: string
  }
  distance_miles: number | null
}

export interface MatchRequest {
  loadId: string
  origin: string
  destination: string
  originLat: number | null
  originLng: number | null
  equipmentType: string
  carrierCost: number
  revenue: number
  maxResults?: number
  minGrade?: MatchGrade
  excludeCarriers?: string[]
}

export interface MatchResponse {
  load_id: string
  matches: CarrierMatch[]
  total_eligible_carriers: number
  total_scored: number
  timestamp: string
}

const WEIGHTS = {
  lane: 0.30,
  proximity: 0.25,
  rate: 0.20,
  reliability: 0.15,
  relationship: 0.10,
}

/**
 * Tenant-scoped match. Opens its own withTenant transaction internally.
 * Use matchCarriersWithClient if you already hold a PoolClient inside another tx.
 */
export async function matchCarriers(
  tenantId: number,
  request: MatchRequest,
): Promise<MatchResponse> {
  return withTenant(tenantId, (client) => matchCarriersWithClient(client, request))
}

export async function matchCarriersWithClient(
  client: PoolClient,
  request: MatchRequest,
): Promise<MatchResponse> {
  const maxResults = request.maxResults || 5
  const minScore = request.minGrade ? gradeToMinScore(request.minGrade) : 0

  const targetCarrierRate =
    request.carrierCost > 0
      ? request.carrierCost
      : request.revenue > 0
        ? request.revenue * 0.78
        : 0

  const eligible = await getEligibleCarriers(
    client,
    request.equipmentType,
    request.excludeCarriers,
  )

  const scoredMatches: CarrierMatch[] = []

  for (const carrier of eligible) {
    const [lane, proximity, rate, reliability, relationship] = await Promise.all([
      scoreLaneFamiliarity(client, carrier.id, request.origin, request.destination),
      scoreProximity(
        client,
        carrier.id,
        request.originLat,
        request.originLng,
        carrier.homeLat,
        carrier.homeLng,
      ),
      scoreRate(client, carrier.id, request.origin, request.destination, targetCarrierRate),
      scoreReliability(
        client,
        carrier.id,
        carrier.communicationRating,
        carrier.onTimePercent,
      ),
      scoreRelationship(client, carrier.id),
    ])

    const finalScore =
      lane.score * WEIGHTS.lane +
      proximity.score * WEIGHTS.proximity +
      rate.score * WEIGHTS.rate +
      reliability.score * WEIGHTS.reliability +
      relationship.score * WEIGHTS.relationship

    const roundedScore = Math.round(finalScore * 1000) / 1000
    const grade = scoreToGrade(roundedScore)

    if (roundedScore < minScore) continue

    scoredMatches.push({
      rank: 0,
      carrier_id: carrier.id,
      carrier_name: carrier.company,
      match_score: roundedScore,
      match_grade: grade,
      breakdown: {
        lane_familiarity: {
          score: lane.score,
          weight: WEIGHTS.lane,
          loads_on_lane: lane.exactLaneCount,
        },
        proximity: {
          score: proximity.score,
          weight: WEIGHTS.proximity,
          distance_km: proximity.distanceKm,
          driver_id: proximity.driverId,
          gps_confidence: proximity.gpsConfidence,
        },
        rate: {
          score: rate.score,
          weight: WEIGHTS.rate,
          carrier_avg_rate: rate.carrierAvgRate,
        },
        reliability: {
          score: reliability.score,
          weight: WEIGHTS.reliability,
          on_time_pct: reliability.onTimePct,
          total_loads: reliability.totalLoads,
        },
        relationship: {
          score: relationship.score,
          weight: WEIGHTS.relationship,
          days_since_last: relationship.daysSinceLastLoad,
        },
      },
      suggested_driver: proximity.driverId
        ? {
            id: proximity.driverId,
            name: proximity.driverName,
            phone: proximity.driverPhone,
          }
        : null,
      contact: {
        name: carrier.contactName,
        phone: carrier.contactPhone,
      },
      distance_miles:
        proximity.distanceKm >= 0 ? Math.round(kmToMiles(proximity.distanceKm)) : null,
    })
  }

  scoredMatches.sort((a, b) => b.match_score - a.match_score)
  const topMatches = scoredMatches.slice(0, maxResults)
  topMatches.forEach((m, i) => (m.rank = i + 1))

  return {
    load_id: request.loadId,
    matches: topMatches,
    total_eligible_carriers: eligible.length,
    total_scored: scoredMatches.length,
    timestamp: new Date().toISOString(),
  }
}

export async function storeMatchResults(
  tenantId: number,
  loadId: string,
  matches: CarrierMatch[],
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    for (const match of matches) {
      const id = `MR-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 5).toUpperCase()}`
      await client.query(
        `INSERT INTO match_results (id, load_id, carrier_id, match_score, match_grade, breakdown)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, loadId, match.carrier_id, match.match_score, match.match_grade, JSON.stringify(match.breakdown)],
      )
    }
  })
}

export { scoreToGrade, gradeToMinScore, GRADE_COLORS, type MatchGrade } from "./grades"
export { haversine, kmToMiles } from "./haversine"
