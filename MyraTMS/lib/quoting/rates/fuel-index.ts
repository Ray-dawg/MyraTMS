import { getDb } from "@/lib/db"

// Canadian Trucking Standard fuel surcharge formula
const BASE_DIESEL_PRICE = 1.25 // CAD per litre (contract baseline)
const FUEL_CONSUMPTION_PER_100KM = 40 // litres per 100 km (avg tractor-trailer)

export interface FuelSurchargeResult {
  pricePerLitre: number
  surchargePerKm: number
  totalSurcharge: number
  source: string
}

export async function getLatestFuelPrice(): Promise<{ price: number; pricePerLitre: number; source: string }> {
  try {
    const sql = getDb()
    const rows = await sql`
      SELECT price_per_litre, source
      FROM fuel_index
      ORDER BY effective_date DESC
      LIMIT 1
    `
    if (rows.length > 0) {
      const price = Number(rows[0].price_per_litre)
      return {
        price,
        pricePerLitre: price,
        source: String(rows[0].source),
      }
    }
  } catch {
    // fall through to default
  }
  // Hardcoded Ontario average if DB unavailable
  return { price: 1.64, pricePerLitre: 1.64, source: "hardcoded" }
}

/**
 * Calculate the fuel surcharge in CAD for a given distance and diesel price.
 * @param distanceKm - driving distance in kilometres
 * @param dieselPricePerLitre - current diesel price in CAD per litre
 * @returns total fuel surcharge amount in CAD (non-negative)
 */
export function calculateFuelSurcharge(distanceKm: number, dieselPricePerLitre: number): number {
  const surchargePerKm = (dieselPricePerLitre - BASE_DIESEL_PRICE) * (FUEL_CONSUMPTION_PER_100KM / 100)
  return Math.max(0, Math.round(surchargePerKm * distanceKm * 100) / 100)
}

/**
 * Async helper that fetches the latest fuel price and returns a full FuelSurchargeResult.
 * Retained for callers that need the detailed breakdown.
 */
export async function calculateFuelSurchargeDetailed(distanceKm: number): Promise<FuelSurchargeResult> {
  const { price, source } = await getLatestFuelPrice()
  const surchargePerKm = ((price - BASE_DIESEL_PRICE) * FUEL_CONSUMPTION_PER_100KM) / 100
  const totalSurcharge = Math.max(0, surchargePerKm * distanceKm)
  return {
    pricePerLitre: price,
    surchargePerKm,
    totalSurcharge: Math.round(totalSurcharge * 100) / 100,
    source,
  }
}

export async function updateFuelPrice(
  pricePerLitre: number,
  source: string = "manual",
  region: string = "Ontario"
): Promise<void> {
  const sql = getDb()
  await sql`
    INSERT INTO fuel_index (source, price_per_litre, region, effective_date)
    VALUES (${source}, ${pricePerLitre}, ${region}, CURRENT_DATE)
  `
}
