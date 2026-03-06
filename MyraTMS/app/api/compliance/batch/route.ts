import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

// ---------------------------------------------------------------------------
// POST /api/compliance/batch
// Body: { carrierIds: string[] }  (optional — verifies all carriers if omitted)
// Verifies multiple carriers against FMCSA in sequence with rate limiting.
// ---------------------------------------------------------------------------

interface VerifyResult {
  carrier_id: string
  company: string
  mc_number: string
  dot_number: string
  authority_status: string
  insurance_status: string
  days_until_expiry: number | null
  safety_rating: string
  compliant: boolean
  last_verified: string
  fmcsa_called: boolean
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const sql = getDb()
  const fmcsaKey = process.env.FMCSA_API_KEY

  let body: { carrierIds?: string[] } = {}
  try {
    body = await req.json()
  } catch {
    // If no body provided, verify all carriers
  }

  // Get carriers to verify
  let carrierRows
  if (body.carrierIds && body.carrierIds.length > 0) {
    carrierRows = await sql`SELECT * FROM carriers WHERE id = ANY(${body.carrierIds}) ORDER BY company`
  } else {
    carrierRows = await sql`SELECT * FROM carriers ORDER BY company`
  }

  if (carrierRows.length === 0) {
    return apiError("No carriers found", 404)
  }

  const results: VerifyResult[] = []
  const now = new Date().toISOString()

  for (const carrier of carrierRows) {
    let fmcsaCalled = false

    // If FMCSA API key exists and carrier has DOT number, make real call
    if (fmcsaKey && carrier.dot_number) {
      try {
        const cleanDot = (carrier.dot_number as string).replace(/\D/g, "")
        const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers/${cleanDot}?webKey=${fmcsaKey}`
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) })

        if (res.ok) {
          const data = await res.json()
          const fc = data?.content?.carrier
          if (fc) {
            const authorityStatus = fc.allowedToOperate?.toUpperCase() === "Y" ? "Active" : "Inactive"
            const safetyRating = fc.safetyRating?.toLowerCase().includes("satisfactory") && !fc.safetyRating?.toLowerCase().includes("unsatisfactory")
              ? "Satisfactory"
              : fc.safetyRating?.toLowerCase().includes("unsatisfactory")
                ? "Unsatisfactory"
                : fc.safetyRating?.toLowerCase().includes("conditional")
                  ? "Conditional"
                  : "Not Rated"
            const vehicleOos = fc.vehicleOosRate ?? carrier.vehicle_oos_percent ?? 0
            const driverOos = fc.driverOosRate ?? carrier.driver_oos_percent ?? 0

            // Update carrier in DB
            await sql`
              UPDATE carriers SET
                authority_status = ${authorityStatus},
                safety_rating = ${safetyRating},
                liability_insurance = ${fc.bipdInsuranceOnFile ?? carrier.liability_insurance ?? 0},
                cargo_insurance = ${fc.cargoInsuranceOnFile ?? carrier.cargo_insurance ?? 0},
                vehicle_oos_percent = ${vehicleOos},
                driver_oos_percent = ${driverOos},
                last_fmcsa_sync = ${now},
                updated_at = NOW()
              WHERE id = ${carrier.id}
            `

            // Auto-generate alerts
            const alerts: Array<{ type: string; severity: string; title: string; description: string }> = []

            if (authorityStatus !== "Active") {
              alerts.push({
                type: "authority_inactive",
                severity: "critical",
                title: "Authority Inactive / Revoked",
                description: `${carrier.company} (${carrier.mc_number}) authority is ${authorityStatus}.`,
              })
            }

            if (carrier.insurance_expiry) {
              const daysUntil = Math.floor((new Date(carrier.insurance_expiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
              if (daysUntil < 0) {
                alerts.push({
                  type: "insurance_expired",
                  severity: "critical",
                  title: "Insurance Expired",
                  description: `Insurance for ${carrier.company} expired ${Math.abs(daysUntil)} days ago.`,
                })
              } else if (daysUntil <= 30) {
                alerts.push({
                  type: "insurance_expiring",
                  severity: "warning",
                  title: "Insurance Expiring Soon",
                  description: `Insurance for ${carrier.company} expires in ${daysUntil} days.`,
                })
              }
            }

            if (safetyRating === "Unsatisfactory" || safetyRating === "Conditional") {
              alerts.push({
                type: "safety_concern",
                severity: safetyRating === "Unsatisfactory" ? "critical" : "warning",
                title: `${safetyRating} Safety Rating`,
                description: `${carrier.company} has a ${safetyRating} safety rating.`,
              })
            }

            if (driverOos > 5.51 || vehicleOos > 20.72) {
              alerts.push({
                type: "high_oos_rate",
                severity: vehicleOos > 25 || driverOos > 10 ? "critical" : "warning",
                title: "High Out-of-Service Rate",
                description: `Vehicle OOS: ${vehicleOos}%. Driver OOS: ${driverOos}%.`,
              })
            }

            // Resolve old alerts, insert new
            await sql`UPDATE compliance_alerts SET resolved = true, resolved_at = NOW() WHERE carrier_id = ${carrier.id} AND resolved = false`

            for (const alert of alerts) {
              await sql`
                INSERT INTO compliance_alerts (id, carrier_id, type, severity, title, description, detected_at, resolved)
                VALUES (
                  ${"CMP-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase()},
                  ${carrier.id}, ${alert.type}, ${alert.severity}, ${alert.title}, ${alert.description}, NOW(), false
                )
              `
            }

            fmcsaCalled = true
          }
        }

        // Rate limit: 200ms between FMCSA calls
        await sleep(200)
      } catch (err) {
        console.error(`[FMCSA Batch] Error for carrier ${carrier.id}:`, err)
      }
    }

    // Calculate insurance status from DB data
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

    results.push({
      carrier_id: carrier.id,
      company: carrier.company,
      mc_number: carrier.mc_number,
      dot_number: carrier.dot_number,
      authority_status: carrier.authority_status || "Unknown",
      insurance_status: insuranceStatus,
      days_until_expiry: daysUntilExpiry,
      safety_rating: carrier.safety_rating || "Not Rated",
      compliant:
        (carrier.authority_status || "Active") === "Active" &&
        insuranceStatus !== "Expired" &&
        (carrier.safety_rating || "Not Rated") !== "Unsatisfactory",
      last_verified: now,
      fmcsa_called: fmcsaCalled,
    })
  }

  const compliant = results.filter((r) => r.compliant).length
  const nonCompliant = results.filter((r) => !r.compliant).length
  const expiringSoon = results.filter((r) => r.days_until_expiry !== null && r.days_until_expiry > 0 && r.days_until_expiry <= 30).length

  return NextResponse.json({
    carriers: results,
    summary: { total: results.length, compliant, non_compliant: nonCompliant, expiring_soon: expiringSoon },
    verified_at: now,
    api_connected: !!fmcsaKey,
  })
}
