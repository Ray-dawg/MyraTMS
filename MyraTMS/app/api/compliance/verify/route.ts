import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

// ---------------------------------------------------------------------------
// POST /api/compliance/verify
// Body: { dotNumber } or { mcNumber } or { carrierId }
// If FMCSA_API_KEY is set, calls real FMCSA API. Otherwise returns mock data.
// ---------------------------------------------------------------------------

interface FmcsaContent {
  carrier?: {
    allowedToOperate?: string
    bipdInsuranceOnFile?: number
    bipdInsuranceRequired?: string
    cargoInsuranceOnFile?: number
    cargoInsuranceRequired?: string
    safetyRating?: string
    safetyRatingDate?: string
    vehicleOosRate?: number
    driverOosRate?: number
    dotNumber?: number
    legalName?: string
    mcNumber?: string
    statusCode?: string
    insuranceRequired?: string
  }
}

async function fetchFmcsa(dotNumber: string, apiKey: string): Promise<FmcsaContent | null> {
  try {
    // Strip non-numeric prefix if present (e.g., "USDOT-1284510" -> "1284510")
    const cleanDot = dotNumber.replace(/\D/g, "")
    const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers/${cleanDot}?webKey=${apiKey}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return null
    const data = await res.json()
    return data?.content as FmcsaContent
  } catch (err) {
    console.error("[FMCSA] API call failed:", err)
    return null
  }
}

function mapAuthorityStatus(allowedToOperate?: string): string {
  if (!allowedToOperate) return "Not Rated"
  const val = allowedToOperate.toUpperCase()
  if (val === "Y" || val === "YES") return "Active"
  if (val === "N" || val === "NO") return "Inactive"
  return "Inactive"
}

function mapSafetyRating(rating?: string): string {
  if (!rating) return "Not Rated"
  const val = rating.toLowerCase()
  if (val.includes("satisfactory")) return "Satisfactory"
  if (val.includes("conditional")) return "Conditional"
  if (val.includes("unsatisfactory")) return "Unsatisfactory"
  return "Not Rated"
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  let body: { dotNumber?: string; mcNumber?: string; carrierId?: string }
  try {
    body = await req.json()
  } catch {
    return apiError("Invalid JSON body")
  }

  const { dotNumber, mcNumber, carrierId } = body
  if (!dotNumber && !mcNumber && !carrierId) {
    return apiError("Provide dotNumber, mcNumber, or carrierId")
  }

  const sql = getDb()
  const fmcsaKey = process.env.FMCSA_API_KEY

  // Resolve carrier from DB
  let carrierRows
  if (carrierId) {
    carrierRows = await sql`SELECT * FROM carriers WHERE id = ${carrierId} LIMIT 1`
  } else if (dotNumber) {
    carrierRows = await sql`SELECT * FROM carriers WHERE dot_number = ${dotNumber} LIMIT 1`
  } else if (mcNumber) {
    carrierRows = await sql`SELECT * FROM carriers WHERE mc_number = ${mcNumber} LIMIT 1`
  }

  const carrier = carrierRows?.[0]
  if (!carrier) {
    return apiError("Carrier not found in database", 404)
  }

  // If FMCSA_API_KEY exists, make real API call
  if (fmcsaKey && carrier.dot_number) {
    const fmcsa = await fetchFmcsa(carrier.dot_number, fmcsaKey)

    if (fmcsa?.carrier) {
      const fc = fmcsa.carrier
      const authorityStatus = mapAuthorityStatus(fc.allowedToOperate)
      const safetyRating = mapSafetyRating(fc.safetyRating)
      const liabilityInsurance = fc.bipdInsuranceOnFile ?? carrier.liability_insurance ?? 0
      const cargoInsurance = fc.cargoInsuranceOnFile ?? carrier.cargo_insurance ?? 0
      const vehicleOosPercent = fc.vehicleOosRate ?? carrier.vehicle_oos_percent ?? 0
      const driverOosPercent = fc.driverOosRate ?? carrier.driver_oos_percent ?? 0
      const now = new Date().toISOString()

      // UPDATE carrier with FMCSA data
      await sql`
        UPDATE carriers SET
          authority_status = ${authorityStatus},
          safety_rating = ${safetyRating},
          liability_insurance = ${liabilityInsurance},
          cargo_insurance = ${cargoInsurance},
          vehicle_oos_percent = ${vehicleOosPercent},
          driver_oos_percent = ${driverOosPercent},
          last_fmcsa_sync = ${now},
          updated_at = NOW()
        WHERE id = ${carrier.id}
      `

      // Auto-generate compliance_alerts based on issues found
      const alerts: Array<{
        carrier_id: string
        type: string
        severity: string
        title: string
        description: string
      }> = []

      if (authorityStatus !== "Active") {
        alerts.push({
          carrier_id: carrier.id,
          type: "authority_inactive",
          severity: "critical",
          title: "Authority Inactive / Revoked",
          description: `Operating authority status: ${authorityStatus}. Carrier ${carrier.company} (${carrier.mc_number}) cannot legally operate.`,
        })
      }

      // Check insurance expiry
      if (carrier.insurance_expiry) {
        const expiryDate = new Date(carrier.insurance_expiry)
        const daysUntil = Math.floor((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        if (daysUntil < 0) {
          alerts.push({
            carrier_id: carrier.id,
            type: "insurance_expired",
            severity: "critical",
            title: "Insurance Expired",
            description: `Insurance for ${carrier.company} (${carrier.mc_number}) expired ${Math.abs(daysUntil)} days ago.`,
          })
        } else if (daysUntil <= 30) {
          alerts.push({
            carrier_id: carrier.id,
            type: "insurance_expiring",
            severity: "warning",
            title: "Insurance Expiring Soon",
            description: `Insurance for ${carrier.company} (${carrier.mc_number}) expires in ${daysUntil} days.`,
          })
        }
      }

      if (safetyRating === "Unsatisfactory") {
        alerts.push({
          carrier_id: carrier.id,
          type: "safety_concern",
          severity: "critical",
          title: "Unsatisfactory Safety Rating",
          description: `${carrier.company} (${carrier.mc_number}) has an Unsatisfactory FMCSA safety rating.`,
        })
      } else if (safetyRating === "Conditional") {
        alerts.push({
          carrier_id: carrier.id,
          type: "safety_concern",
          severity: "warning",
          title: "Conditional Safety Rating",
          description: `${carrier.company} (${carrier.mc_number}) has a Conditional FMCSA safety rating. Review required.`,
        })
      }

      // High OOS rates (driver >5.51% national avg, vehicle >20.72% national avg)
      if (driverOosPercent > 5.51 || vehicleOosPercent > 20.72) {
        alerts.push({
          carrier_id: carrier.id,
          type: "high_oos_rate",
          severity: vehicleOosPercent > 25 || driverOosPercent > 10 ? "critical" : "warning",
          title: "High Out-of-Service Rate",
          description: `Vehicle OOS: ${vehicleOosPercent}% (avg 20.72%). Driver OOS: ${driverOosPercent}% (avg 5.51%).`,
        })
      }

      // Resolve existing unresolved alerts for this carrier, then insert new ones
      await sql`
        UPDATE compliance_alerts SET resolved = true, resolved_at = NOW()
        WHERE carrier_id = ${carrier.id} AND resolved = false
      `

      for (const alert of alerts) {
        await sql`
          INSERT INTO compliance_alerts (id, carrier_id, type, severity, title, description, detected_at, resolved)
          VALUES (
            ${"CMP-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase()},
            ${alert.carrier_id},
            ${alert.type},
            ${alert.severity},
            ${alert.title},
            ${alert.description},
            NOW(),
            false
          )
        `
      }

      // Calculate days until insurance expiry
      const daysUntilExpiry = carrier.insurance_expiry
        ? Math.floor((new Date(carrier.insurance_expiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : null

      const insuranceStatus = daysUntilExpiry === null
        ? "Unknown"
        : daysUntilExpiry < 0
          ? "Expired"
          : daysUntilExpiry <= 30
            ? "Expiring"
            : "Active"

      return NextResponse.json({
        carrier_id: carrier.id,
        company: carrier.company,
        mc_number: carrier.mc_number,
        dot_number: carrier.dot_number,
        authority_status: authorityStatus,
        insurance_expiry: carrier.insurance_expiry,
        insurance_status: insuranceStatus,
        days_until_expiry: daysUntilExpiry,
        liability_insurance: liabilityInsurance,
        cargo_insurance: cargoInsurance,
        safety_rating: safetyRating,
        vehicle_oos_percent: vehicleOosPercent,
        driver_oos_percent: driverOosPercent,
        last_fmcsa_sync: now,
        api_connected: true,
        compliant: authorityStatus === "Active" && insuranceStatus !== "Expired" && safetyRating !== "Unsatisfactory",
        alerts_generated: alerts.length,
      })
    }
  }

  // Fallback: return DB data without live FMCSA verification
  const daysUntilExpiry = carrier.insurance_expiry
    ? Math.floor((new Date(carrier.insurance_expiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null

  const insuranceStatus = daysUntilExpiry === null
    ? "Unknown"
    : daysUntilExpiry < 0
      ? "Expired"
      : daysUntilExpiry <= 30
        ? "Expiring"
        : "Active"

  return NextResponse.json({
    carrier_id: carrier.id,
    company: carrier.company,
    mc_number: carrier.mc_number,
    dot_number: carrier.dot_number,
    authority_status: carrier.authority_status || "Unknown",
    insurance_expiry: carrier.insurance_expiry,
    insurance_status: insuranceStatus,
    days_until_expiry: daysUntilExpiry,
    liability_insurance: carrier.liability_insurance || 0,
    cargo_insurance: carrier.cargo_insurance || 0,
    safety_rating: carrier.safety_rating || "Not Rated",
    vehicle_oos_percent: carrier.vehicle_oos_percent || 0,
    driver_oos_percent: carrier.driver_oos_percent || 0,
    last_fmcsa_sync: carrier.last_fmcsa_sync || null,
    api_connected: false,
    compliant:
      (carrier.authority_status || "Active") === "Active" &&
      insuranceStatus !== "Expired" &&
      (carrier.safety_rating || "Not Rated") !== "Unsatisfactory",
    alerts_generated: 0,
  })
}
