import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

interface FmcsaContent {
  carrier?: {
    allowedToOperate?: string
    bipdInsuranceOnFile?: number
    cargoInsuranceOnFile?: number
    safetyRating?: string
    vehicleOosRate?: number
    driverOosRate?: number
    legalName?: string
    mcNumber?: string
    statusCode?: string
  }
}

async function fetchFmcsa(dotNumber: string, apiKey: string): Promise<FmcsaContent | null> {
  try {
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
  if (val.includes("satisfactory") && !val.includes("unsatisfactory")) return "Satisfactory"
  if (val.includes("conditional")) return "Conditional"
  if (val.includes("unsatisfactory")) return "Unsatisfactory"
  return "Not Rated"
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)

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

  const fmcsaKey = process.env.FMCSA_API_KEY

  const carrier = await withTenant(ctx.tenantId, async (client) => {
    if (carrierId) {
      const { rows } = await client.query(
        `SELECT * FROM carriers WHERE id = $1 LIMIT 1`,
        [carrierId],
      )
      return rows[0] ?? null
    }
    if (dotNumber) {
      const { rows } = await client.query(
        `SELECT * FROM carriers WHERE dot_number = $1 LIMIT 1`,
        [dotNumber],
      )
      return rows[0] ?? null
    }
    if (mcNumber) {
      const { rows } = await client.query(
        `SELECT * FROM carriers WHERE mc_number = $1 LIMIT 1`,
        [mcNumber],
      )
      return rows[0] ?? null
    }
    return null
  })

  if (!carrier) return apiError("Carrier not found in database", 404)

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

      const alerts: Array<{
        type: string
        severity: string
        title: string
        description: string
      }> = []

      if (authorityStatus !== "Active") {
        alerts.push({
          type: "authority_inactive",
          severity: "critical",
          title: "Authority Inactive / Revoked",
          description: `Operating authority status: ${authorityStatus}. Carrier ${carrier.company} (${carrier.mc_number}) cannot legally operate.`,
        })
      }
      if (carrier.insurance_expiry) {
        const expiryDate = new Date(carrier.insurance_expiry)
        const daysUntil = Math.floor((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        if (daysUntil < 0) {
          alerts.push({
            type: "insurance_expired",
            severity: "critical",
            title: "Insurance Expired",
            description: `Insurance for ${carrier.company} (${carrier.mc_number}) expired ${Math.abs(daysUntil)} days ago.`,
          })
        } else if (daysUntil <= 30) {
          alerts.push({
            type: "insurance_expiring",
            severity: "warning",
            title: "Insurance Expiring Soon",
            description: `Insurance for ${carrier.company} (${carrier.mc_number}) expires in ${daysUntil} days.`,
          })
        }
      }
      if (safetyRating === "Unsatisfactory") {
        alerts.push({
          type: "safety_concern",
          severity: "critical",
          title: "Unsatisfactory Safety Rating",
          description: `${carrier.company} (${carrier.mc_number}) has an Unsatisfactory FMCSA safety rating.`,
        })
      } else if (safetyRating === "Conditional") {
        alerts.push({
          type: "safety_concern",
          severity: "warning",
          title: "Conditional Safety Rating",
          description: `${carrier.company} (${carrier.mc_number}) has a Conditional FMCSA safety rating. Review required.`,
        })
      }
      if (driverOosPercent > 5.51 || vehicleOosPercent > 20.72) {
        alerts.push({
          type: "high_oos_rate",
          severity: vehicleOosPercent > 25 || driverOosPercent > 10 ? "critical" : "warning",
          title: "High Out-of-Service Rate",
          description: `Vehicle OOS: ${vehicleOosPercent}% (avg 20.72%). Driver OOS: ${driverOosPercent}% (avg 5.51%).`,
        })
      }

      await withTenant(ctx.tenantId, async (client) => {
        await client.query(
          `UPDATE carriers SET
             authority_status = $1, safety_rating = $2, liability_insurance = $3,
             cargo_insurance = $4, vehicle_oos_percent = $5, driver_oos_percent = $6,
             last_fmcsa_sync = $7, updated_at = NOW()
           WHERE id = $8`,
          [authorityStatus, safetyRating, liabilityInsurance, cargoInsurance, vehicleOosPercent, driverOosPercent, now, carrier.id],
        )
        await client.query(
          `UPDATE compliance_alerts SET resolved = true, resolved_at = NOW()
            WHERE carrier_id = $1 AND resolved = false`,
          [carrier.id],
        )
        for (const alert of alerts) {
          const id = `CMP-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`
          await client.query(
            `INSERT INTO compliance_alerts (id, carrier_id, type, severity, title, description, detected_at, resolved)
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), false)`,
            [id, carrier.id, alert.type, alert.severity, alert.title, alert.description],
          )
        }
      })

      const daysUntilExpiry = carrier.insurance_expiry
        ? Math.floor((new Date(carrier.insurance_expiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : null
      const insuranceStatus =
        daysUntilExpiry === null
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
        compliant:
          authorityStatus === "Active" &&
          insuranceStatus !== "Expired" &&
          safetyRating !== "Unsatisfactory",
        alerts_generated: alerts.length,
      })
    }
  }

  // Fallback: DB-only response
  const daysUntilExpiry = carrier.insurance_expiry
    ? Math.floor((new Date(carrier.insurance_expiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null
  const insuranceStatus =
    daysUntilExpiry === null
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
