/**
 * Fuel surcharge calculation from fuel_index table.
 *
 * NOTE: fuel_index is currently a GLOBAL (non-tenant-scoped) reference table —
 * see migration 029 which intentionally omits it from RLS coverage. The
 * client param is accepted for connection sharing inside withTenant blocks
 * but no tenant filter is applied.
 */

import type { PoolClient } from "@neondatabase/serverless"
import { withTenant } from "@/lib/db/tenant-context"
import { BASE_DIESEL_PRICE, FUEL_CONSUMPTION_PER_100KM } from "./benchmark"

export async function getLatestFuelPrice(client?: PoolClient): Promise<{
  pricePerLitre: number
  effectiveDate: string
  source: string
}> {
  const queryFn = async (c: PoolClient) => {
    const { rows } = await c.query(
      `SELECT * FROM fuel_index ORDER BY effective_date DESC LIMIT 1`,
    )
    if (rows.length === 0) {
      return { pricePerLitre: 1.64, effectiveDate: new Date().toISOString(), source: "default" }
    }
    return {
      pricePerLitre: Number(rows[0].price_per_litre),
      effectiveDate: rows[0].effective_date,
      source: rows[0].source,
    }
  }

  if (client) return queryFn(client)

  // Standalone call: open a service-admin tx since fuel_index is global
  // (use any tenant with status='active' via withTenant for connection acquisition)
  const { LEGACY_DEFAULT_TENANT_ID } = await import("@/lib/auth")
  return withTenant(LEGACY_DEFAULT_TENANT_ID, queryFn)
}

/** Fuel surcharge in CAD based on distance and current diesel price above baseline */
export function calculateFuelSurcharge(distanceKm: number, dieselPricePerLitre: number): number {
  const surchargePerKm = (dieselPricePerLitre - BASE_DIESEL_PRICE) * (FUEL_CONSUMPTION_PER_100KM / 100)
  return Math.max(0, surchargePerKm * distanceKm)
}
