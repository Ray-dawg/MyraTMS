import type { PoolClient } from "@neondatabase/serverless"

export interface RelationshipResult {
  score: number
  daysSinceLastLoad: number | null
  loadsLast90d: number
}

export async function scoreRelationship(
  client: PoolClient,
  carrierId: string,
): Promise<RelationshipResult> {
  const { rows: result } = await client.query(
    `SELECT MAX(created_at) as last_date, COUNT(*) as total_loads_90d
       FROM loads
      WHERE carrier_id = $1
        AND status IN ('Delivered', 'Invoiced', 'Closed')
        AND created_at > NOW() - INTERVAL '90 days'`,
    [carrierId],
  )

  const lastDate = result[0]?.last_date as string | null
  const totalLoads90d = Number(result[0]?.total_loads_90d) || 0

  if (!lastDate) {
    return { score: 0.1, daysSinceLastLoad: null, loadsLast90d: 0 }
  }

  const daysSince = Math.floor((Date.now() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24))

  let recency: number
  if (daysSince <= 7) recency = 1.0
  else if (daysSince <= 14) recency = 0.8
  else if (daysSince <= 30) recency = 0.6
  else if (daysSince <= 60) recency = 0.3
  else recency = 0.1

  const freq = Math.min(1.0, totalLoads90d / 10)
  const score = recency * 0.6 + freq * 0.4

  return {
    score: Math.max(0, Math.min(1.0, score)),
    daysSinceLastLoad: daysSince,
    loadsLast90d: totalLoads90d,
  }
}
