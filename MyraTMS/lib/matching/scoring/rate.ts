import type { NeonQueryFunction } from "@neondatabase/serverless"
import { extractRegion } from "../regions"

export interface RateResult {
  score: number
  carrierAvgRate: number | null
  dataSource: "exact_lane" | "all_loads" | "no_data"
}

/**
 * Rate Competitiveness Score (Weight: 0.20)
 * Estimates whether this carrier will accept a rate that preserves target margin.
 */
export async function scoreRate(
  sql: NeonQueryFunction<false, false>,
  carrierId: string,
  originStr: string,
  destStr: string,
  targetCarrierRate: number
): Promise<RateResult> {
  if (targetCarrierRate <= 0) {
    return { score: 0.5, carrierAvgRate: null, dataSource: "no_data" }
  }

  const originRegion = extractRegion(originStr)
  const destRegion = extractRegion(destStr)

  // Try exact lane history first (last 90 days)
  const laneRate = await sql`
    SELECT AVG(carrier_cost) as avg_rate
    FROM loads
    WHERE carrier_id = ${carrierId}
      AND LOWER(origin) LIKE ${"%" + originRegion + "%"}
      AND LOWER(destination) LIKE ${"%" + destRegion + "%"}
      AND status IN ('Delivered', 'Invoiced', 'Closed')
      AND carrier_cost > 0
      AND created_at > NOW() - INTERVAL '90 days'
  `

  let avgRate = laneRate[0]?.avg_rate ? Number(laneRate[0].avg_rate) : null
  let dataSource: RateResult["dataSource"] = "exact_lane"

  if (avgRate == null) {
    // Fall back to all loads for this carrier
    const allRate = await sql`
      SELECT AVG(carrier_cost) as avg_rate
      FROM loads
      WHERE carrier_id = ${carrierId}
        AND status IN ('Delivered', 'Invoiced', 'Closed')
        AND carrier_cost > 0
        AND created_at > NOW() - INTERVAL '90 days'
    `
    avgRate = allRate[0]?.avg_rate ? Number(allRate[0].avg_rate) : null
    dataSource = "all_loads"
  }

  if (avgRate == null) {
    return { score: 0.5, carrierAvgRate: null, dataSource: "no_data" }
  }

  // Score: carrier's typical rate vs our target carrier rate
  const ratio = avgRate / targetCarrierRate
  let score: number
  if (ratio <= 1.0) score = 1.0
  else if (ratio <= 1.05) score = 0.8
  else if (ratio <= 1.1) score = 0.6
  else if (ratio <= 1.2) score = 0.3
  else score = 0.1

  return {
    score,
    carrierAvgRate: Math.round(avgRate * 100) / 100,
    dataSource,
  }
}
