/**
 * 6-source rate cascade — the core pricing engine.
 *
 * Priority order:
 * 1. Historical loads (≥5 loads on lane)
 * 2. DAT API (stubbed — wired in Task 7)
 * 3. Truckstop API (stubbed — wired in Task 7)
 * 4. Manual rate cache
 * 5. AI estimation (stubbed — wired in Task 8)
 * 6. Benchmark formula (always returns)
 */

import { getDb } from "@/lib/db"
import { calculateHistoricalConfidence, calculateManualCacheConfidence } from "./confidence"
import { calculateBenchmarkRate, type EquipmentType } from "@/lib/rates/benchmark"
import { fetchDATRate } from "@/lib/rates/dat-client"
import { fetchTruckstopRate } from "@/lib/rates/truckstop-client"
import { estimateRateWithAI } from "@/lib/rates/ai-estimator"

export interface RateResult {
  ratePerMile: number
  totalRate: number
  source: string
  confidence: number
  sourceDetail: Record<string, unknown>
  rangeLow: number
  rangeHigh: number
}

export async function lookupRate(
  originRegion: string,
  destRegion: string,
  equipmentType: EquipmentType,
  distanceMiles: number,
  pickupDate: Date
): Promise<RateResult> {
  // Source 1: Historical loads
  const historical = await queryHistoricalLoads(originRegion, destRegion, equipmentType)
  if (historical && historical.loadCount >= 5) {
    const confidence = calculateHistoricalConfidence(historical.loadCount, historical.mostRecent)
    const totalRate = historical.avgRatePerMile * distanceMiles
    return {
      ratePerMile: historical.avgRatePerMile,
      totalRate,
      source: "historical",
      confidence,
      sourceDetail: { loadCount: historical.loadCount, avgRate: historical.avgRatePerMile, mostRecent: historical.mostRecent.toISOString() },
      rangeLow: historical.minRatePerMile * distanceMiles,
      rangeHigh: historical.maxRatePerMile * distanceMiles,
    }
  }

  // Source 2: DAT API (stubbed — wired in Task 7)
  const datRate = await tryDATLookup(originRegion, destRegion, equipmentType)
  if (datRate) {
    if (historical && historical.loadCount >= 1) {
      // Blend: 30% historical + 70% DAT
      const blended = historical.avgRatePerMile * 0.3 + datRate.ratePerMile * 0.7
      return {
        ratePerMile: blended,
        totalRate: blended * distanceMiles,
        source: "dat+historical",
        confidence: 0.85,
        sourceDetail: { datRate: datRate.ratePerMile, historicalRate: historical.avgRatePerMile, historicalCount: historical.loadCount },
        rangeLow: datRate.rangeLow,
        rangeHigh: datRate.rangeHigh,
      }
    }
    return { ...datRate, source: "dat", confidence: 0.80 }
  }

  // Source 3: Truckstop API (stubbed — wired in Task 7)
  const truckstopRate = await tryTruckstopLookup(originRegion, destRegion, equipmentType)
  if (truckstopRate) {
    if (historical && historical.loadCount >= 1) {
      const blended = historical.avgRatePerMile * 0.3 + truckstopRate.ratePerMile * 0.7
      return {
        ratePerMile: blended,
        totalRate: blended * distanceMiles,
        source: "truckstop+historical",
        confidence: 0.82,
        sourceDetail: { truckstopRate: truckstopRate.ratePerMile, historicalRate: historical.avgRatePerMile, historicalCount: historical.loadCount },
        rangeLow: truckstopRate.rangeLow,
        rangeHigh: truckstopRate.rangeHigh,
      }
    }
    return { ...truckstopRate, source: "truckstop", confidence: 0.80 }
  }

  // Source 4: Manual rate cache
  const manual = await queryRateCache("manual", originRegion, destRegion, equipmentType)
  if (manual) {
    const ageDays = (Date.now() - new Date(manual.fetched_at).getTime()) / 86400000
    const confidence = calculateManualCacheConfidence(ageDays)
    return {
      ratePerMile: Number(manual.rate_per_mile),
      totalRate: Number(manual.total_rate || 0) || Number(manual.rate_per_mile) * distanceMiles,
      source: "manual_cache",
      confidence,
      sourceDetail: { ageDays: Math.round(ageDays), fetchedAt: manual.fetched_at },
      rangeLow: Number(manual.rate_per_mile) * 0.9 * distanceMiles,
      rangeHigh: Number(manual.rate_per_mile) * 1.1 * distanceMiles,
    }
  }

  // Source 5: AI estimation (stubbed — wired in Task 8)
  const aiRate = await tryAIEstimation(originRegion, destRegion, equipmentType, distanceMiles)
  if (aiRate) {
    return { ...aiRate, source: "ai", confidence: 0.55 }
  }

  // Source 6: Benchmark formula (always works)
  const benchmark = calculateBenchmarkRate(distanceMiles, equipmentType, pickupDate)
  return {
    ratePerMile: benchmark.ratePerMile,
    totalRate: benchmark.ratePerMile * distanceMiles,
    source: "benchmark",
    confidence: benchmark.confidence,
    sourceDetail: { method: "benchmark_table", seasonal: true },
    rangeLow: benchmark.rangeLow * distanceMiles,
    rangeHigh: benchmark.rangeHigh * distanceMiles,
  }
}

// ── Helpers ──────────────────────────────────────────────────

interface HistoricalResult {
  loadCount: number
  avgRatePerMile: number
  minRatePerMile: number
  maxRatePerMile: number
  mostRecent: Date
}

async function queryHistoricalLoads(
  originRegion: string, destRegion: string, equipmentType: string
): Promise<HistoricalResult | null> {
  const sql = getDb()

  // Look for completed loads on the same lane in the last 180 days
  const rows = await sql`
    SELECT
      COUNT(*) as load_count,
      AVG(CASE WHEN carrier_cost > 0 THEN carrier_cost / NULLIF(
        (SELECT distance_miles FROM distance_cache dc
         WHERE dc.origin_address = l.origin AND dc.dest_address = l.destination
         ORDER BY dc.created_at DESC LIMIT 1), 0)
      END) as avg_rate_per_mile,
      MIN(CASE WHEN carrier_cost > 0 THEN carrier_cost / NULLIF(
        (SELECT distance_miles FROM distance_cache dc
         WHERE dc.origin_address = l.origin AND dc.dest_address = l.destination
         ORDER BY dc.created_at DESC LIMIT 1), 0)
      END) as min_rate_per_mile,
      MAX(CASE WHEN carrier_cost > 0 THEN carrier_cost / NULLIF(
        (SELECT distance_miles FROM distance_cache dc
         WHERE dc.origin_address = l.origin AND dc.dest_address = l.destination
         ORDER BY dc.created_at DESC LIMIT 1), 0)
      END) as max_rate_per_mile,
      MAX(l.created_at) as most_recent
    FROM loads l
    WHERE l.status IN ('Delivered', 'Invoiced', 'Closed')
      AND l.equipment = ${equipmentType}
      AND l.carrier_cost > 0
      AND l.created_at > NOW() - INTERVAL '180 days'
  `

  if (!rows[0] || Number(rows[0].load_count) === 0 || !rows[0].avg_rate_per_mile) {
    return null
  }

  return {
    loadCount: Number(rows[0].load_count),
    avgRatePerMile: Number(rows[0].avg_rate_per_mile),
    minRatePerMile: Number(rows[0].min_rate_per_mile),
    maxRatePerMile: Number(rows[0].max_rate_per_mile),
    mostRecent: new Date(rows[0].most_recent),
  }
}

async function queryRateCache(
  source: string, originRegion: string, destRegion: string, equipmentType: string
) {
  const sql = getDb()
  const rows = await sql`
    SELECT * FROM rate_cache
    WHERE source = ${source}
      AND origin_region = ${originRegion}
      AND dest_region = ${destRegion}
      AND equipment_type = ${equipmentType}
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY fetched_at DESC
    LIMIT 1
  `
  return rows[0] || null
}

// ── External Source Wrappers ─────────────────────────────────

async function tryDATLookup(origin: string, dest: string, equipment: string): Promise<RateResult | null> {
  try {
    const dat = await fetchDATRate(origin, dest, equipment)
    if (!dat || !dat.averageRatePerMile) return null
    return {
      ratePerMile: dat.averageRatePerMile,
      totalRate: dat.averageTotalRate,
      source: "dat",
      confidence: 0.80,
      sourceDetail: { reportCount: dat.reportCount, mileage: dat.mileage },
      rangeLow: dat.lowRatePerMile * (dat.mileage || 1),
      rangeHigh: dat.highRatePerMile * (dat.mileage || 1),
    }
  } catch {
    return null
  }
}

async function tryTruckstopLookup(origin: string, dest: string, equipment: string): Promise<RateResult | null> {
  try {
    const ts = await fetchTruckstopRate(origin, dest, equipment)
    if (!ts || !ts.averageRatePerMile) return null
    return {
      ratePerMile: ts.averageRatePerMile,
      totalRate: ts.averageRate,
      source: "truckstop",
      confidence: 0.80,
      sourceDetail: { loadCount: ts.loadCount, trend: ts.trend, trendPercent: ts.trendPercent },
      rangeLow: ts.lowRate,
      rangeHigh: ts.highRate,
    }
  } catch {
    return null
  }
}

async function tryAIEstimation(
  origin: string, dest: string, equipment: string, distanceMiles: number
): Promise<RateResult | null> {
  try {
    const distanceKm = distanceMiles / 0.621371
    const ai = await estimateRateWithAI(origin, dest, equipment, distanceMiles, distanceKm, new Date())
    if (!ai || !ai.ratePerMile) return null
    return {
      ratePerMile: ai.ratePerMile,
      totalRate: ai.totalRate,
      source: "ai",
      confidence: ai.confidence,
      sourceDetail: { reasoning: ai.reasoning },
      rangeLow: ai.rangeLow,
      rangeHigh: ai.rangeHigh,
    }
  } catch {
    return null
  }
}
