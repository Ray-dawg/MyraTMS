// Benchmark rate table — CAD per mile, calibrated to Canadian truckload market
// Used as the final fallback when no other source is available (Source 6)

export type EquipmentType = "dry_van" | "reefer" | "flatbed" | "step_deck"

interface RateRange {
  low: number
  high: number
  midpoint: number
}

type DistanceBand = "under_100" | "100_250" | "250_500" | "500_1000" | "over_1000"

const BENCHMARK_TABLE: Record<DistanceBand, Record<EquipmentType, RateRange>> = {
  under_100: {
    dry_van:   { low: 5.50, high: 7.00, midpoint: 6.25 },
    reefer:    { low: 6.50, high: 8.00, midpoint: 7.25 },
    flatbed:   { low: 6.00, high: 8.50, midpoint: 7.25 },
    step_deck: { low: 6.50, high: 9.00, midpoint: 7.75 },
  },
  "100_250": {
    dry_van:   { low: 3.50, high: 4.50, midpoint: 4.00 },
    reefer:    { low: 4.00, high: 5.50, midpoint: 4.75 },
    flatbed:   { low: 4.00, high: 5.50, midpoint: 4.75 },
    step_deck: { low: 4.25, high: 5.75, midpoint: 5.00 },
  },
  "250_500": {
    dry_van:   { low: 2.80, high: 3.80, midpoint: 3.30 },
    reefer:    { low: 3.30, high: 4.50, midpoint: 3.90 },
    flatbed:   { low: 3.20, high: 4.50, midpoint: 3.85 },
    step_deck: { low: 3.40, high: 4.75, midpoint: 4.08 },
  },
  "500_1000": {
    dry_van:   { low: 2.40, high: 3.20, midpoint: 2.80 },
    reefer:    { low: 2.80, high: 3.80, midpoint: 3.30 },
    flatbed:   { low: 2.80, high: 3.80, midpoint: 3.30 },
    step_deck: { low: 3.00, high: 4.00, midpoint: 3.50 },
  },
  over_1000: {
    dry_van:   { low: 2.00, high: 2.80, midpoint: 2.40 },
    reefer:    { low: 2.40, high: 3.40, midpoint: 2.90 },
    flatbed:   { low: 2.40, high: 3.40, midpoint: 2.90 },
    step_deck: { low: 2.60, high: 3.60, midpoint: 3.10 },
  },
}

function getDistanceBand(miles: number): DistanceBand {
  if (miles < 100) return "under_100"
  if (miles < 250) return "100_250"
  if (miles < 500) return "250_500"
  if (miles < 1000) return "500_1000"
  return "over_1000"
}

function getSeasonalFactor(pickupDate: string | Date): number {
  const date = typeof pickupDate === "string" ? new Date(pickupDate) : pickupDate
  const month = date.getMonth() + 1 // 1–12
  // Canadian freight seasonality:
  // Peak: May–June (harvest prep), Oct–Nov (pre-winter rush) → 1.10–1.15
  // Soft: Jan–Feb (post-holiday winter) → 0.90–0.95
  // Normal: rest of year → 1.00
  if (month === 1 || month === 2) return 0.92
  if (month === 5 || month === 6) return 1.10
  if (month === 10 || month === 11) return 1.12
  return 1.00
}

export interface BenchmarkResult {
  ratePerMile: number
  rateRangeLow: number
  rateRangeHigh: number
  distanceBand: DistanceBand
  seasonalFactor: number
}

export function getBenchmarkRate(
  distanceMiles: number,
  equipment: string,
  pickupDate: string | Date = new Date()
): BenchmarkResult {
  const band = getDistanceBand(distanceMiles)
  const equip = (equipment.toLowerCase().replace(/[^a-z_]/g, "_") as EquipmentType) in BENCHMARK_TABLE[band]
    ? (equipment.toLowerCase().replace(/[^a-z_]/g, "_") as EquipmentType)
    : "dry_van"

  const range = BENCHMARK_TABLE[band][equip] ?? BENCHMARK_TABLE[band].dry_van
  const seasonal = getSeasonalFactor(pickupDate)

  return {
    ratePerMile: range.midpoint * seasonal,
    rateRangeLow: range.low * seasonal,
    rateRangeHigh: range.high * seasonal,
    distanceBand: band,
    seasonalFactor: seasonal,
  }
}
