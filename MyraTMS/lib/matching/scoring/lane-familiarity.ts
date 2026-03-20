import type { NeonQueryFunction } from "@neondatabase/serverless"
import { extractRegion } from "../regions"
import { escapeLikeMeta } from "@/lib/escape-like"

export interface LaneFamiliarityResult {
  score: number
  exactLaneCount: number
  nearbyLaneCount: number
  mostRecentDate: string | null
}

/**
 * Lane Familiarity Score (Weight: 0.30)
 * Measures how well a carrier knows this specific lane based on historical loads.
 */
export async function scoreLaneFamiliarity(
  sql: NeonQueryFunction<false, false>,
  carrierId: string,
  originStr: string,
  destStr: string
): Promise<LaneFamiliarityResult> {
  const originRegion = extractRegion(originStr)
  const destRegion = extractRegion(destStr)

  if (!originRegion || !destRegion) {
    return { score: 0, exactLaneCount: 0, nearbyLaneCount: 0, mostRecentDate: null }
  }

  // Count completed loads on this exact lane (last 180 days)
  const exactLane = await sql`
    SELECT COUNT(*) as count,
           MAX(created_at) as most_recent
    FROM loads
    WHERE carrier_id = ${carrierId}
      AND LOWER(origin) LIKE ${`%${escapeLikeMeta(originRegion)}%`}
      AND LOWER(destination) LIKE ${`%${escapeLikeMeta(destRegion)}%`}
      AND status IN ('Delivered', 'Invoiced', 'Closed')
      AND created_at > NOW() - INTERVAL '180 days'
  `

  const exactCount = Number(exactLane[0]?.count) || 0
  const mostRecent = exactLane[0]?.most_recent as string | null

  // Count loads on reverse or nearby lanes
  const nearbyLanes = await sql`
    SELECT COUNT(*) as count
    FROM loads
    WHERE carrier_id = ${carrierId}
      AND (
        (LOWER(origin) LIKE ${`%${escapeLikeMeta(destRegion)}%`} AND LOWER(destination) LIKE ${`%${escapeLikeMeta(originRegion)}%`})
        OR LOWER(origin) LIKE ${`%${escapeLikeMeta(originRegion.split(",")[0]?.trim() ?? "")}%`}
      )
      AND status IN ('Delivered', 'Invoiced', 'Closed')
      AND created_at > NOW() - INTERVAL '180 days'
  `

  const nearbyCount = Number(nearbyLanes[0]?.count) || 0

  // Base score
  let base: number
  if (exactCount >= 5) base = 1.0
  else if (exactCount >= 3) base = 0.8
  else if (exactCount >= 1) base = 0.6
  else if (nearbyCount >= 3) base = 0.4
  else if (nearbyCount >= 1) base = 0.2
  else base = 0.0

  // Recency bonus: +0.1 if last load on lane within 30 days
  let recencyBonus = 0
  if (mostRecent) {
    const daysSince = (Date.now() - new Date(mostRecent).getTime()) / (1000 * 60 * 60 * 24)
    if (daysSince <= 30) recencyBonus = 0.1
  }

  return {
    score: Math.min(1.0, base + recencyBonus),
    exactLaneCount: exactCount,
    nearbyLaneCount: nearbyCount,
    mostRecentDate: mostRecent,
  }
}
