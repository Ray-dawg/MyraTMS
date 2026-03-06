/**
 * Fuel surcharge calculation from fuel_index table.
 */

import { getDb } from "@/lib/db"
import { BASE_DIESEL_PRICE, FUEL_CONSUMPTION_PER_100KM } from "./benchmark"

export async function getLatestFuelPrice(): Promise<{
  pricePerLitre: number
  effectiveDate: string
  source: string
}> {
  const sql = getDb()
  const rows = await sql`SELECT * FROM fuel_index ORDER BY effective_date DESC LIMIT 1`
  if (rows.length === 0) {
    return { pricePerLitre: 1.64, effectiveDate: new Date().toISOString(), source: "default" }
  }
  return {
    pricePerLitre: Number(rows[0].price_per_litre),
    effectiveDate: rows[0].effective_date,
    source: rows[0].source,
  }
}

/** Fuel surcharge in CAD based on distance and current diesel price above baseline */
export function calculateFuelSurcharge(distanceKm: number, dieselPricePerLitre: number): number {
  const surchargePerKm = (dieselPricePerLitre - BASE_DIESEL_PRICE) * (FUEL_CONSUMPTION_PER_100KM / 100)
  return Math.max(0, surchargePerKm * distanceKm)
}
