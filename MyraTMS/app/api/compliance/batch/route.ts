import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

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
  const ctx = requireTenantContext(req)

  const fmcsaKey = process.env.FMCSA_API_KEY

  let body: { carrierIds?: string[] } = {}
  try {
    body = await req.json()
  } catch {
    // empty body OK — verify all carriers
  }

  const carrierRows = await withTenant(ctx.tenantId, async (client) => {
    if (body.carrierIds && body.carrierIds.length > 0) {
      const { rows } = await client.query(
        `SELECT * FROM carriers WHERE id = ANY($1::text[]) ORDER BY company`,
        [body.carrierIds],
      )
      return rows
    }
    const { rows } = await client.query(`SELECT * FROM carriers ORDER BY company`)
    return rows
  })

  if (carrierRows.length === 0) return apiError("No carriers found", 404)

  const results: VerifyResult[] = []
  const now = new Date().toISOString()

  for (const carrier of carrierRows) {
    let fmcsaCalled = false

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
            const safetyRating = fc.safetyRating?.toLowerCase().includes("unsatisfactory")
              ? "Unsatisfactory"
              : fc.safetyRating?.toLowerCase().includes("conditional")
                ? "Conditional"
                : fc.safetyRating?.toLowerCase().includes("satisfactory")
                  ? "Satisfactory"
                  : "Not Rated"
            const vehicleOos = fc.vehicleOosRate ?? carrier.vehicle_oos_percent ?? 0
            const driverOos = fc.driverOosRate ?? carrier.driver_oos_percent ?? 0

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

            await withTenant(ctx.tenantId, async (client) => {
              await client.query(
                `UPDATE carriers SET
                   authority_status = $1, safety_rating = $2,
                   liability_insurance = $3, cargo_insurance = $4,
                   vehicle_oos_percent = $5, driver_oos_percent = $6,
                   last_fmcsa_sync = $7, updated_at = NOW()
                 WHERE id = $8`,
                [
                  authorityStatus,
                  safetyRating,
                  fc.bipdInsuranceOnFile ?? carrier.liability_insurance ?? 0,
                  fc.cargoInsuranceOnFile ?? carrier.cargo_insurance ?? 0,
                  vehicleOos,
                  driverOos,
                  now,
                  carrier.id,
                ],
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

            fmcsaCalled = true
          }
        }
        await sleep(200)
      } catch (err) {
        console.error(`[FMCSA Batch] Error for carrier ${carrier.id}:`, err)
      }
    }

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
  const expiringSoon = results.filter(
    (r) => r.days_until_expiry !== null && r.days_until_expiry > 0 && r.days_until_expiry <= 30,
  ).length

  return NextResponse.json({
    carriers: results,
    summary: { total: results.length, compliant, non_compliant: nonCompliant, expiring_soon: expiringSoon },
    verified_at: now,
    api_connected: !!fmcsaKey,
  })
}
