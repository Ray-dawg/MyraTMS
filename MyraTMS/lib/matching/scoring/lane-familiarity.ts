import type { PoolClient } from "@neondatabase/serverless"
import { extractRegion } from "../regions"
import { escapeLikeMeta } from "@/lib/escape-like"

export interface LaneFamiliarityResult {
  score: number
  exactLaneCount: number
  nearbyLaneCount: number
  mostRecentDate: string | null
}

export async function scoreLaneFamiliarity(
  client: PoolClient,
  carrierId: string,
  originStr: string,
  destStr: string,
): Promise<LaneFamiliarityResult> {
  const originRegion = extractRegion(originStr)
  const destRegion = extractRegion(destStr)

  if (!originRegion || !destRegion) {
    return { score: 0, exactLaneCount: 0, nearbyLaneCount: 0, mostRecentDate: null }
  }

  const originLike = `%${escapeLikeMeta(originRegion)}%`
  const destLike = `%${escapeLikeMeta(destRegion)}%`

  const { rows: exactLane } = await client.query(
    `SELECT COUNT(*) as count, MAX(created_at) as most_recent
       FROM loads
      WHERE carrier_id = $1
        AND LOWER(origin) LIKE $2
        AND LOWER(destination) LIKE $3
        AND status IN ('Delivered', 'Invoiced', 'Closed')
        AND created_at > NOW() - INTERVAL '180 days'`,
    [carrierId, originLike, destLike],
  )

  const exactCount = Number(exactLane[0]?.count) || 0
  const mostRecent = exactLane[0]?.most_recent as string | null

  const originCityLike = `%${escapeLikeMeta(originRegion.split(",")[0]?.trim() ?? "")}%`

  const { rows: nearbyLanes } = await client.query(
    `SELECT COUNT(*) as count
       FROM loads
      WHERE carrier_id = $1
        AND (
          (LOWER(origin) LIKE $2 AND LOWER(destination) LIKE $3)
          OR LOWER(origin) LIKE $4
        )
        AND status IN ('Delivered', 'Invoiced', 'Closed')
        AND created_at > NOW() - INTERVAL '180 days'`,
    [carrierId, destLike, originLike, originCityLike],
  )

  const nearbyCount = Number(nearbyLanes[0]?.count) || 0

  let base: number
  if (exactCount >= 5) base = 1.0
  else if (exactCount >= 3) base = 0.8
  else if (exactCount >= 1) base = 0.6
  else if (nearbyCount >= 3) base = 0.4
  else if (nearbyCount >= 1) base = 0.2
  else base = 0.0

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
