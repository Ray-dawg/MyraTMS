import type { PoolClient } from "@neondatabase/serverless"
import { extractRegion } from "../regions"
import { escapeLikeMeta } from "@/lib/escape-like"

export interface RateResult {
  score: number
  carrierAvgRate: number | null
  dataSource: "exact_lane" | "all_loads" | "no_data"
}

export async function scoreRate(
  client: PoolClient,
  carrierId: string,
  originStr: string,
  destStr: string,
  targetCarrierRate: number,
): Promise<RateResult> {
  if (targetCarrierRate <= 0) {
    return { score: 0.5, carrierAvgRate: null, dataSource: "no_data" }
  }

  const originRegion = extractRegion(originStr)
  const destRegion = extractRegion(destStr)
  const originLike = `%${escapeLikeMeta(originRegion)}%`
  const destLike = `%${escapeLikeMeta(destRegion)}%`

  const { rows: laneRate } = await client.query(
    `SELECT AVG(carrier_cost) as avg_rate
       FROM loads
      WHERE carrier_id = $1
        AND LOWER(origin) LIKE $2
        AND LOWER(destination) LIKE $3
        AND status IN ('Delivered', 'Invoiced', 'Closed')
        AND carrier_cost > 0
        AND created_at > NOW() - INTERVAL '90 days'`,
    [carrierId, originLike, destLike],
  )

  let avgRate = laneRate[0]?.avg_rate ? Number(laneRate[0].avg_rate) : null
  let dataSource: RateResult["dataSource"] = "exact_lane"

  if (avgRate == null) {
    const { rows: allRate } = await client.query(
      `SELECT AVG(carrier_cost) as avg_rate
         FROM loads
        WHERE carrier_id = $1
          AND status IN ('Delivered', 'Invoiced', 'Closed')
          AND carrier_cost > 0
          AND created_at > NOW() - INTERVAL '90 days'`,
      [carrierId],
    )
    avgRate = allRate[0]?.avg_rate ? Number(allRate[0].avg_rate) : null
    dataSource = "all_loads"
  }

  if (avgRate == null) {
    return { score: 0.5, carrierAvgRate: null, dataSource: "no_data" }
  }

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
