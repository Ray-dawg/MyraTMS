/**
 * Quote orchestrator — main pipeline that generates a complete quote.
 *
 * Steps:
 * 1. Calculate distance (geocode + driving route)
 * 2. Normalize regions
 * 3. Rate cascade lookup
 * 4. Fuel surcharge
 * 5. Margin calculation
 * 6. Assemble and store quote
 */

import { getDistance } from "@/lib/geo/distance-service"
import { normalizeRegion } from "@/lib/geo/region-mapper"
import { lookupRate } from "./cascade"
import { getLatestFuelPrice, calculateFuelSurcharge } from "@/lib/rates/fuel-index"
import { calculateMargin } from "./margin"
import { getConfidenceLabel } from "./confidence"
import { getDb } from "@/lib/db"
import type { EquipmentType } from "@/lib/rates/benchmark"

export interface QuoteRequest {
  origin: string
  destination: string
  equipmentType: string
  weightLbs?: number
  pickupDate?: string
  shipperId?: string
  shipperName?: string
  targetMargin?: number
  commodity?: string
}

export interface QuoteResult {
  id: string
  reference: string
  shipperId: string | null
  shipperName: string
  originAddress: string
  originLat: number
  originLng: number
  originRegion: string
  destAddress: string
  destLat: number
  destLng: number
  destRegion: string
  equipmentType: string
  weightLbs: number
  commodity: string
  pickupDate: string
  distanceMiles: number
  distanceKm: number
  driveTimeHours: number
  ratePerMile: number
  carrierCostEstimate: number
  fuelSurcharge: number
  shipperRate: number
  marginPercent: number
  marginDollars: number
  rateSource: string
  rateSourceDetail: Record<string, unknown>
  confidence: number
  confidenceLabel: string
  rateRangeLow: number
  rateRangeHigh: number
  status: string
  validUntil: string
  loadId: string | null
  createdAt: string
  updatedAt: string
}

export async function generateQuote(request: QuoteRequest): Promise<QuoteResult> {
  const sql = getDb()

  // Step 1: Distance
  const distance = await getDistance(request.origin, request.destination)

  // Step 2: Region normalization
  const originRegion = normalizeRegion(distance.originLat, distance.originLng)
  const destRegion = normalizeRegion(distance.destLat, distance.destLng)

  // Step 3: Rate cascade
  const pickupDate = new Date(request.pickupDate || Date.now())
  const rate = await lookupRate(
    originRegion.region,
    destRegion.region,
    (request.equipmentType || "dry_van") as EquipmentType,
    distance.distanceMiles,
    pickupDate
  )

  // Step 4: Fuel surcharge
  const fuel = await getLatestFuelPrice()
  const fuelSurcharge = calculateFuelSurcharge(distance.distanceKm, fuel.pricePerLitre)

  // Step 5: Margin
  const shipperHistory = request.shipperId
    ? await getShipperLoadCount(sql, request.shipperId)
    : 0
  const margin = calculateMargin({
    shipperId: request.shipperId || null,
    shipperLoadCount: shipperHistory,
    confidenceScore: rate.confidence,
    isUrgent: false,
    targetMargin: request.targetMargin !== undefined ? request.targetMargin : null,
  })

  const carrierCost = rate.ratePerMile * distance.distanceMiles + fuelSurcharge
  const shipperRate = carrierCost / (1 - margin)
  const marginDollars = shipperRate - carrierCost

  // Step 6: Assemble + store
  const id = `QT-${Date.now().toString(36).toUpperCase()}`
  const reference = await generateQuoteReference(sql)
  const confidenceLabel = getConfidenceLabel(rate.confidence)
  const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days
  const now = new Date().toISOString()
  const pickupDateStr = pickupDate.toISOString().split("T")[0]

  await sql`
    INSERT INTO quotes (
      id, reference, shipper_id, shipper_name,
      origin_address, origin_lat, origin_lng, origin_region,
      dest_address, dest_lat, dest_lng, dest_region,
      equipment_type, weight_lbs, commodity, pickup_date,
      distance_miles, distance_km, drive_time_hours,
      rate_per_mile, carrier_cost_estimate, fuel_surcharge,
      shipper_rate, margin_percent, margin_dollars,
      rate_source, rate_source_detail, confidence, confidence_label,
      rate_range_low, rate_range_high,
      status, valid_until
    ) VALUES (
      ${id}, ${reference}, ${request.shipperId || null}, ${request.shipperName || ""},
      ${request.origin}, ${distance.originLat}, ${distance.originLng}, ${originRegion.region},
      ${request.destination}, ${distance.destLat}, ${distance.destLng}, ${destRegion.region},
      ${request.equipmentType || "dry_van"}, ${request.weightLbs || 42000}, ${request.commodity || ""}, ${pickupDateStr},
      ${distance.distanceMiles}, ${distance.distanceKm}, ${distance.driveTimeHours},
      ${rate.ratePerMile}, ${carrierCost}, ${fuelSurcharge},
      ${shipperRate}, ${margin}, ${marginDollars},
      ${rate.source}, ${JSON.stringify(rate.sourceDetail)}, ${rate.confidence}, ${confidenceLabel},
      ${rate.rangeLow}, ${rate.rangeHigh},
      ${"draft"}, ${validUntil}
    )
  `

  return {
    id,
    reference,
    shipperId: request.shipperId || null,
    shipperName: request.shipperName || "",
    originAddress: request.origin,
    originLat: distance.originLat,
    originLng: distance.originLng,
    originRegion: originRegion.region,
    destAddress: request.destination,
    destLat: distance.destLat,
    destLng: distance.destLng,
    destRegion: destRegion.region,
    equipmentType: request.equipmentType || "dry_van",
    weightLbs: request.weightLbs || 42000,
    commodity: request.commodity || "",
    pickupDate: pickupDateStr,
    distanceMiles: distance.distanceMiles,
    distanceKm: distance.distanceKm,
    driveTimeHours: distance.driveTimeHours,
    ratePerMile: rate.ratePerMile,
    carrierCostEstimate: carrierCost,
    fuelSurcharge,
    shipperRate,
    marginPercent: margin,
    marginDollars,
    rateSource: rate.source,
    rateSourceDetail: rate.sourceDetail,
    confidence: rate.confidence,
    confidenceLabel,
    rateRangeLow: rate.rangeLow,
    rateRangeHigh: rate.rangeHigh,
    status: "draft",
    validUntil,
    loadId: null,
    createdAt: now,
    updatedAt: now,
  }
}

async function generateQuoteReference(sql: ReturnType<typeof getDb>): Promise<string> {
  const year = new Date().getFullYear()
  // Get current quote count for the year
  const rows = await sql`
    SELECT COUNT(*) as count FROM quotes
    WHERE reference LIKE ${"MYR-Q-" + year + "-%"}
  `
  const num = Number(rows[0]?.count || 0) + 1
  return `MYR-Q-${year}-${String(num).padStart(4, "0")}`
}

async function getShipperLoadCount(sql: ReturnType<typeof getDb>, shipperId: string): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*) as count FROM loads
    WHERE shipper_id = ${shipperId}
      AND status IN ('Delivered', 'Invoiced', 'Closed')
  `
  return Number(rows[0]?.count || 0)
}
