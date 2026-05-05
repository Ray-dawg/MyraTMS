import type { PoolClient } from "@neondatabase/serverless"

export interface ReliabilityResult {
  score: number
  totalLoads: number
  onTimePct: number | null
  damageClaims: number
  commRating: number | null
  label: "NEW" | "PROVEN" | "VETERAN"
}

export async function scoreReliability(
  client: PoolClient,
  carrierId: string,
  carrierCommRating: number | null,
  carrierOnTimePercent: number | null,
): Promise<ReliabilityResult> {
  const { rows: stats } = await client.query(
    `SELECT
       COUNT(*) as total_loads,
       AVG(CASE
         WHEN delivery_date IS NOT NULL AND updated_at <= delivery_date + INTERVAL '1 day'
         THEN 1.0 ELSE 0.0
       END) as on_time_rate
       FROM loads
      WHERE carrier_id = $1
        AND status IN ('Delivered', 'Invoiced', 'Closed')
        AND created_at > NOW() - INTERVAL '365 days'`,
    [carrierId],
  )

  const totalLoads = Number(stats[0]?.total_loads) || 0

  if (totalLoads < 3) {
    return {
      score: 0.5,
      totalLoads,
      onTimePct: null,
      damageClaims: 0,
      commRating: carrierCommRating,
      label: "NEW",
    }
  }

  const onTimeRate =
    carrierOnTimePercent != null
      ? carrierOnTimePercent / 100
      : Number(stats[0]?.on_time_rate) || 0.5

  const commNormalized = carrierCommRating != null ? (carrierCommRating - 1) / 4 : 0.5
  const volumeBonus = Math.min(1.0, totalLoads / 20)

  const score = onTimeRate * 0.4 + commNormalized * 0.3 + volumeBonus * 0.3

  return {
    score: Math.max(0, Math.min(1.0, score)),
    totalLoads,
    onTimePct: Math.round(onTimeRate * 100),
    damageClaims: 0,
    commRating: carrierCommRating,
    label: totalLoads >= 10 ? "VETERAN" : "PROVEN",
  }
}
