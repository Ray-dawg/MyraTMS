import type { PoolClient } from "@neondatabase/serverless"
import { withTenant } from "@/lib/db/tenant-context"
import { LEGACY_DEFAULT_TENANT_ID } from "@/lib/auth"

// Canadian Trucking Standard fuel surcharge formula
const BASE_DIESEL_PRICE = 1.25 // CAD per litre (contract baseline)
const FUEL_CONSUMPTION_PER_100KM = 40 // litres per 100 km (avg tractor-trailer)

export interface FuelSurchargeResult {
  pricePerLitre: number
  surchargePerKm: number
  totalSurcharge: number
  source: string
}

export async function getLatestFuelPrice(
  client?: PoolClient,
): Promise<{ price: number; pricePerLitre: number; source: string }> {
  const queryFn = async (c: PoolClient) => {
    try {
      const { rows } = await c.query(
        `SELECT price_per_litre, source FROM fuel_index
          ORDER BY effective_date DESC LIMIT 1`,
      )
      if (rows.length > 0) {
        const price = Number(rows[0].price_per_litre)
        return { price, pricePerLitre: price, source: String(rows[0].source) }
      }
    } catch {
      // fall through to default
    }
    return { price: 1.64, pricePerLitre: 1.64, source: "hardcoded" }
  }

  if (client) return queryFn(client)
  return withTenant(LEGACY_DEFAULT_TENANT_ID, queryFn)
}

export function calculateFuelSurcharge(distanceKm: number, dieselPricePerLitre: number): number {
  const surchargePerKm = (dieselPricePerLitre - BASE_DIESEL_PRICE) * (FUEL_CONSUMPTION_PER_100KM / 100)
  return Math.max(0, Math.round(surchargePerKm * distanceKm * 100) / 100)
}

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
  region: string = "Ontario",
): Promise<void> {
  await withTenant(LEGACY_DEFAULT_TENANT_ID, async (client) => {
    await client.query(
      `INSERT INTO fuel_index (source, price_per_litre, region, effective_date)
       VALUES ($1, $2, $3, CURRENT_DATE)`,
      [source, pricePerLitre, region],
    )
  })
}
