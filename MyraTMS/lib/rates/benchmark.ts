/**
 * Hardcoded CAD rate-per-mile benchmark table.
 * Source 6 in the cascade — always returns a result.
 */

export interface BenchmarkRate {
  low: number
  mid: number
  high: number
}

export type EquipmentType = "dry_van" | "reefer" | "flatbed" | "step_deck"
export type DistanceBand = "under_100" | "100_250" | "250_500" | "500_1000" | "over_1000"

/** CAD rate-per-mile by distance band and equipment type */
export const BENCHMARK_RATES: Record<DistanceBand, Record<EquipmentType, BenchmarkRate>> = {
  under_100: {
    dry_van:   { low: 5.50, mid: 6.25, high: 7.00 },
    reefer:    { low: 6.50, mid: 7.25, high: 8.00 },
    flatbed:   { low: 6.00, mid: 7.25, high: 8.50 },
    step_deck: { low: 6.00, mid: 7.25, high: 8.50 },
  },
  "100_250": {
    dry_van:   { low: 3.50, mid: 4.00, high: 4.50 },
    reefer:    { low: 4.00, mid: 4.75, high: 5.50 },
    flatbed:   { low: 4.00, mid: 4.75, high: 5.50 },
    step_deck: { low: 4.00, mid: 4.75, high: 5.50 },
  },
  "250_500": {
    dry_van:   { low: 2.75, mid: 3.25, high: 3.75 },
    reefer:    { low: 3.25, mid: 3.85, high: 4.50 },
    flatbed:   { low: 3.25, mid: 3.85, high: 4.50 },
    step_deck: { low: 3.25, mid: 3.85, high: 4.50 },
  },
  "500_1000": {
    dry_van:   { low: 2.25, mid: 2.75, high: 3.25 },
    reefer:    { low: 2.75, mid: 3.25, high: 3.75 },
    flatbed:   { low: 2.75, mid: 3.25, high: 3.75 },
    step_deck: { low: 2.75, mid: 3.25, high: 3.75 },
  },
  over_1000: {
    dry_van:   { low: 1.85, mid: 2.25, high: 2.65 },
    reefer:    { low: 2.25, mid: 2.75, high: 3.25 },
    flatbed:   { low: 2.25, mid: 2.75, high: 3.25 },
    step_deck: { low: 2.25, mid: 2.75, high: 3.25 },
  },
}

/** CAD per litre diesel baseline for fuel surcharge calculation */
export const BASE_DIESEL_PRICE = 1.25

/** Litres consumed per 100 km */
export const FUEL_CONSUMPTION_PER_100KM = 40

export function getDistanceBand(miles: number): DistanceBand {
  if (miles < 100) return "under_100"
  if (miles < 250) return "100_250"
  if (miles < 500) return "250_500"
  if (miles < 1000) return "500_1000"
  return "over_1000"
}

/** Returns seasonal multiplier: 0.90 (Jan slack) to 1.15 (Dec peak) */
export function getSeasonalFactor(date: Date): number {
  const month = date.getMonth() // 0-indexed
  const factors = [0.90, 0.92, 0.95, 0.98, 1.00, 1.02, 1.05, 1.05, 1.02, 1.00, 1.08, 1.15]
  return factors[month]
}

export function calculateBenchmarkRate(
  miles: number,
  equipment: EquipmentType,
  date: Date
): { ratePerMile: number; confidence: number; rangeLow: number; rangeHigh: number } {
  const band = getDistanceBand(miles)
  const rates = BENCHMARK_RATES[band][equipment]
  const seasonal = getSeasonalFactor(date)

  return {
    ratePerMile: rates.mid * seasonal,
    confidence: 0.30,
    rangeLow: rates.low * seasonal,
    rangeHigh: rates.high * seasonal,
  }
}
