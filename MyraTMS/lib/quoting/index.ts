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

import { withTenant } from "@/lib/db/tenant-context"
import type { PoolClient } from "@neondatabase/serverless"
import { getDistance } from "@/lib/geo/distance-service"
import { normalizeRegion } from "@/lib/geo/region-mapper"
import { lookupRate } from "./cascade"
import { getLatestFuelPrice, calculateFuelSurcharge } from "@/lib/rates/fuel-index"
import { calculateMargin } from "./margin"
import { getConfidenceLabel } from "./confidence"
import type { EquipmentType } from "@/lib/rates/benchmark"

export interface QuoteRequest {
  tenantId: number
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
  // Step 1: Distance (uses distance_cache — global, no tenant scope needed)
  const distance = await getDistance(request.origin, request.destination)

  // Step 2: Region normalization
  const originRegion = normalizeRegion(distance.originLat, distance.originLng)
  const destRegion = normalizeRegion(distance.destLat, distance.destLng)

  // Step 3 + 5 + 6: Tenant-scoped operations
  return withTenant(request.tenantId, async (client) => {
    const pickupDate = new Date(request.pickupDate || Date.now())
    const rate = await lookupRate(
      client,
      originRegion.region,
      destRegion.region,
      (request.equipmentType || "dry_van") as EquipmentType,
      distance.distanceMiles,
      pickupDate,
    )

    // Step 4: Fuel (global cache, but we use the same client for connection sharing)
    const fuel = await getLatestFuelPrice(client)
    const fuelSurcharge = calculateFuelSurcharge(distance.distanceKm, fuel.pricePerLitre)

    // Step 5: Margin
    const shipperHistory = request.shipperId
      ? await getShipperLoadCount(client, request.shipperId)
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

    const id = `QT-${Date.now().toString(36).toUpperCase()}`
    const reference = await generateQuoteReference(client)
    const confidenceLabel = getConfidenceLabel(rate.confidence)
    const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const now = new Date().toISOString()
    const pickupDateStr = pickupDate.toISOString().split("T")[0]

    await client.query(
      `INSERT INTO quotes (
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
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
         $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33
       )`,
      [
        id, reference, request.shipperId || null, request.shipperName || "",
        request.origin, distance.originLat, distance.originLng, originRegion.region,
        request.destination, distance.destLat, distance.destLng, destRegion.region,
        request.equipmentType || "dry_van", request.weightLbs || 42000, request.commodity || "", pickupDateStr,
        distance.distanceMiles, distance.distanceKm, distance.driveTimeHours,
        rate.ratePerMile, carrierCost, fuelSurcharge,
        shipperRate, margin, marginDollars,
        rate.source, JSON.stringify(rate.sourceDetail), rate.confidence, confidenceLabel,
        rate.rangeLow, rate.rangeHigh,
        "draft", validUntil,
      ],
    )

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
  })
}

async function generateQuoteReference(client: PoolClient): Promise<string> {
  const year = new Date().getFullYear()
  const { rows } = await client.query(
    `SELECT COUNT(*) as count FROM quotes WHERE reference LIKE $1`,
    [`MYR-Q-${year}-%`],
  )
  const num = Number(rows[0]?.count || 0) + 1
  return `MYR-Q-${year}-${String(num).padStart(4, "0")}`
}

async function getShipperLoadCount(client: PoolClient, shipperId: string): Promise<number> {
  const { rows } = await client.query(
    `SELECT COUNT(*) as count FROM loads
      WHERE shipper_id = $1
        AND status IN ('Delivered', 'Invoiced', 'Closed')`,
    [shipperId],
  )
  return Number(rows[0]?.count || 0)
}
