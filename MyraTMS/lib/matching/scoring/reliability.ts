import type { NeonQueryFunction } from "@neondatabase/serverless"

export interface ReliabilityResult {
  score: number
  totalLoads: number
  onTimePct: number | null
  damageClaims: number
  commRating: number | null
  label: "NEW" | "PROVEN" | "VETERAN"
}

/**
 * Reliability Score (Weight: 0.15)
 * Composite score based on carrier's historical performance.
 * New carriers (<3 loads) get neutral 0.5.
 */
export async function scoreReliability(
  sql: NeonQueryFunction<false, false>,
  carrierId: string,
  carrierCommRating: number | null,
  carrierOnTimePercent: number | null
): Promise<ReliabilityResult> {
  // Get performance stats from last 365 days
  const stats = await sql`
    SELECT
      COUNT(*) as total_loads,
      AVG(CASE
        WHEN delivery_date IS NOT NULL AND updated_at <= delivery_date + INTERVAL '1 day'
        THEN 1.0 ELSE 0.0
      END) as on_time_rate
    FROM loads
    WHERE carrier_id = ${carrierId}
      AND status IN ('Delivered', 'Invoiced', 'Closed')
      AND created_at > NOW() - INTERVAL '365 days'
  `

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

  // Use the on_time_percent from carriers table if available, else calculate
  const onTimeRate = carrierOnTimePercent != null
    ? carrierOnTimePercent / 100
    : (Number(stats[0]?.on_time_rate) || 0.5)

  // Communication rating (1–5 normalized to 0–1)
  const commNormalized = carrierCommRating != null
    ? (carrierCommRating - 1) / 4
    : 0.5

  // Composite: on_time(40%) + communication(30%) + volume_bonus(30%)
  // Volume bonus rewards carriers with more loads (up to 20 loads = max)
  const volumeBonus = Math.min(1.0, totalLoads / 20)

  const score =
    onTimeRate * 0.4 +
    commNormalized * 0.3 +
    volumeBonus * 0.3

  return {
    score: Math.max(0, Math.min(1.0, score)),
    totalLoads,
    onTimePct: Math.round(onTimeRate * 100),
    damageClaims: 0,
    commRating: carrierCommRating,
    label: totalLoads >= 10 ? "VETERAN" : "PROVEN",
  }
}
