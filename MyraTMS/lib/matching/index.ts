import type { NeonQueryFunction } from "@neondatabase/serverless"
import { getEligibleCarriers, type EligibleCarrier } from "./filters"
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

// ── Scoring Weights ──────────────────────────────────────────────

const WEIGHTS = {
  lane: 0.30,
  proximity: 0.25,
  rate: 0.20,
  reliability: 0.15,
  relationship: 0.10,
}

// ── Match Orchestrator ───────────────────────────────────────────

/**
 * Main matching function.
 * Filters eligible carriers, scores each one, ranks by score, returns top N.
 */
export async function matchCarriers(
  sql: NeonQueryFunction<false, false>,
  request: MatchRequest
): Promise<MatchResponse> {
  const maxResults = request.maxResults || 5
  const minScore = request.minGrade ? gradeToMinScore(request.minGrade) : 0

  // Calculate target carrier rate from revenue if carrier_cost not set
  // Default 22% target margin
  const targetCarrierRate =
    request.carrierCost > 0
      ? request.carrierCost
      : request.revenue > 0
        ? request.revenue * 0.78
        : 0

  // Step 1: Hard filter — equipment, active, insured
  const eligible = await getEligibleCarriers(
    sql,
    request.equipmentType,
    request.excludeCarriers
  )

  // Step 2: Score each eligible carrier
  const scoredMatches: CarrierMatch[] = []

  for (const carrier of eligible) {
    const [lane, proximity, rate, reliability, relationship] = await Promise.all([
      scoreLaneFamiliarity(sql, carrier.id, request.origin, request.destination),
      scoreProximity(
        sql,
        carrier.id,
        request.originLat,
        request.originLng,
        carrier.homeLat,
        carrier.homeLng
      ),
      scoreRate(
        sql,
        carrier.id,
        request.origin,
        request.destination,
        targetCarrierRate
      ),
      scoreReliability(
        sql,
        carrier.id,
        carrier.communicationRating,
        carrier.onTimePercent
      ),
      scoreRelationship(sql, carrier.id),
    ])

    // Weighted sum
    const finalScore =
      lane.score * WEIGHTS.lane +
      proximity.score * WEIGHTS.proximity +
      rate.score * WEIGHTS.rate +
      reliability.score * WEIGHTS.reliability +
      relationship.score * WEIGHTS.relationship

    const roundedScore = Math.round(finalScore * 1000) / 1000
    const grade = scoreToGrade(roundedScore)

    // Apply minimum grade filter
    if (roundedScore < minScore) continue

    scoredMatches.push({
      rank: 0, // Set after sorting
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
      suggested_driver:
        proximity.driverId
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
        proximity.distanceKm >= 0
          ? Math.round(kmToMiles(proximity.distanceKm))
          : null,
    })
  }

  // Step 3: Sort by score descending, take top N
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

/**
 * Store match results in the audit table for learning.
 */
export async function storeMatchResults(
  sql: NeonQueryFunction<false, false>,
  loadId: string,
  matches: CarrierMatch[]
): Promise<void> {
  for (const match of matches) {
    const id = `MR-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 5).toUpperCase()}`
    await sql`
      INSERT INTO match_results (id, load_id, carrier_id, match_score, match_grade, breakdown)
      VALUES (
        ${id},
        ${loadId},
        ${match.carrier_id},
        ${match.match_score},
        ${match.match_grade},
        ${JSON.stringify(match.breakdown)}
      )
    `
  }
}

// Re-exports
export { scoreToGrade, gradeToMinScore, GRADE_COLORS, type MatchGrade } from "./grades"
export { haversine, kmToMiles } from "./haversine"
