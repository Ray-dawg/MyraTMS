import type { NeonQueryFunction } from "@neondatabase/serverless"

export interface EligibleCarrier {
  id: string
  company: string
  mcNumber: string
  dotNumber: string
  contactName: string
  contactPhone: string
  homeLat: number | null
  homeLng: number | null
  homeCity: string | null
  communicationRating: number | null
  onTimePercent: number | null
  insuranceExpiry: string | null
}

/**
 * Hard filter: returns only carriers that:
 * 1. Have the required equipment type
 * 2. Are active (not revoked)
 * 3. Have valid insurance (not expired)
 * 4. Are not in the exclude list
 */
export async function getEligibleCarriers(
  sql: NeonQueryFunction<false, false>,
  equipmentType: string,
  excludeCarrierIds: string[] = []
): Promise<EligibleCarrier[]> {
  // Normalize equipment type for matching
  const normalizedEquip = normalizeEquipment(equipmentType)

  const carriers = await sql`
    SELECT DISTINCT
      c.id,
      c.company,
      c.mc_number,
      c.dot_number,
      c.contact_name,
      c.contact_phone,
      c.home_lat,
      c.home_lng,
      c.home_city,
      c.communication_rating,
      c.on_time_percent,
      c.insurance_expiry
    FROM carriers c
    LEFT JOIN carrier_equipment ce ON c.id = ce.carrier_id
    WHERE c.authority_status = 'Active'
      AND (c.insurance_expiry IS NULL OR c.insurance_expiry > CURRENT_DATE)
      AND (
        ce.equipment_type = ${normalizedEquip}
        OR c.id IN (
          SELECT DISTINCT carrier_id FROM loads
          WHERE equipment ILIKE ${"%" + normalizedEquip + "%"}
          AND carrier_id IS NOT NULL
        )
      )
    ORDER BY c.company
  `

  const excludeSet = new Set(excludeCarrierIds)

  return carriers
    .filter((c) => !excludeSet.has(c.id as string))
    .map((c) => ({
      id: c.id as string,
      company: c.company as string,
      mcNumber: (c.mc_number || "") as string,
      dotNumber: (c.dot_number || "") as string,
      contactName: (c.contact_name || "") as string,
      contactPhone: (c.contact_phone || "") as string,
      homeLat: c.home_lat != null ? Number(c.home_lat) : null,
      homeLng: c.home_lng != null ? Number(c.home_lng) : null,
      homeCity: (c.home_city || null) as string | null,
      communicationRating: c.communication_rating != null ? Number(c.communication_rating) : null,
      onTimePercent: c.on_time_percent != null ? Number(c.on_time_percent) : null,
      insuranceExpiry: c.insurance_expiry as string | null,
    }))
}

function normalizeEquipment(equip: string): string {
  const lower = equip.toLowerCase().trim()
  if (lower.includes("reefer") || lower.includes("refriger")) return "Reefer"
  if (lower.includes("flat")) return "Flatbed"
  if (lower.includes("step")) return "Step Deck"
  return "Dry Van"
}
