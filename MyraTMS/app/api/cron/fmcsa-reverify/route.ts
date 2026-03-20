import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"

// POST /api/cron/fmcsa-reverify
// vercel.json: { "path": "/api/cron/fmcsa-reverify", "schedule": "0 6 * * *" }
// Re-verifies active carriers (last_fmcsa_sync NULL or >30 days).
// Processes up to 50 per invocation. Requires x-cron-secret header.

interface FmcsaCarrier {
  allowedToOperate?: string
  bipdInsuranceOnFile?: number
  cargoInsuranceOnFile?: number
  safetyRating?: string
  vehicleOosRate?: number
  driverOosRate?: number
}

interface AlertPayload {
  type: string
  severity: string
  title: string
  description: string
}

function mapAuthorityStatus(allowedToOperate?: string): string {
  if (!allowedToOperate) return "Not Rated"
  const val = allowedToOperate.toUpperCase()
  if (val === "Y" || val === "YES") return "Active"
  return "Inactive"
}

function mapSafetyRating(rating?: string): string {
  if (!rating) return "Not Rated"
  const val = rating.toLowerCase()
  if (val.includes("unsatisfactory")) return "Unsatisfactory"
  if (val.includes("conditional")) return "Conditional"
  if (val.includes("satisfactory")) return "Satisfactory"
  return "Not Rated"
}

async function fetchFmcsa(dotNumber: string, apiKey: string): Promise<FmcsaCarrier | null> {
  const cleanDot = dotNumber.replace(/\D/g, "")
  if (!cleanDot) return null
  try {
    const url = `https://mobile.fmcsa.dot.gov/qc/services/carriers/${cleanDot}?webKey=${apiKey}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const data = await res.json()
    return (data?.content?.carrier as FmcsaCarrier) ?? null
  } catch (err) {
    console.error(`[cron/fmcsa-reverify] FMCSA fetch failed for DOT ${dotNumber}:`, err)
    return null
  }
}

function buildAlerts(carrier: Record<string, unknown>, authorityStatus: string, safetyRating: string, vehicleOos: number, driverOos: number): AlertPayload[] {
  const alerts: AlertPayload[] = []
  const company = carrier.company as string
  const mc = (carrier.mc_number as string) ?? ""

  if (authorityStatus !== "Active") {
    alerts.push({ type: "authority_inactive", severity: "critical", title: "Authority Inactive / Revoked", description: `Operating authority status: ${authorityStatus}. Carrier ${company} (${mc}) cannot legally operate.` })
  }

  if (carrier.insurance_expiry) {
    const daysUntil = Math.floor((new Date(carrier.insurance_expiry as string).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    if (daysUntil < 0) {
      alerts.push({ type: "insurance_expired", severity: "critical", title: "Insurance Expired", description: `Insurance for ${company} (${mc}) expired ${Math.abs(daysUntil)} days ago.` })
    } else if (daysUntil <= 30) {
      alerts.push({ type: "insurance_expiring", severity: "warning", title: "Insurance Expiring Soon", description: `Insurance for ${company} (${mc}) expires in ${daysUntil} days.` })
    }
  }

  if (safetyRating === "Unsatisfactory") {
    alerts.push({ type: "safety_concern", severity: "critical", title: "Unsatisfactory Safety Rating", description: `${company} (${mc}) has an Unsatisfactory FMCSA safety rating.` })
  } else if (safetyRating === "Conditional") {
    alerts.push({ type: "safety_concern", severity: "warning", title: "Conditional Safety Rating", description: `${company} (${mc}) has a Conditional FMCSA safety rating. Review required.` })
  }

  // National averages: driver OOS 5.51%, vehicle OOS 20.72%
  if (driverOos > 5.51 || vehicleOos > 20.72) {
    alerts.push({ type: "high_oos_rate", severity: vehicleOos > 25 || driverOos > 10 ? "critical" : "warning", title: "High Out-of-Service Rate", description: `Vehicle OOS: ${vehicleOos}% (avg 20.72%). Driver OOS: ${driverOos}% (avg 5.51%).` })
  }

  return alerts
}

function alertId(): string {
  return "CMP-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase()
}

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const providedSecret = request.headers.get("x-cron-secret")
  const isDev = process.env.NODE_ENV === "development"

  if (!isDev && cronSecret && providedSecret !== cronSecret) {
    console.warn("[cron/fmcsa-reverify] Unauthorized -- invalid or missing x-cron-secret")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const fmcsaKey = process.env.FMCSA_API_KEY
  if (!fmcsaKey) {
    console.warn("[cron/fmcsa-reverify] FMCSA_API_KEY is not configured -- skipping run")
    return NextResponse.json({ processed: 0, issues_found: 0, errors: [], skipped_reason: "FMCSA_API_KEY not configured" })
  }

  const sql = getDb()
  let processed = 0
  let issues_found = 0
  const errors: string[] = []

  let staleCarriers: Record<string, unknown>[]
  try {
    staleCarriers = await sql`
      SELECT id, company, mc_number, dot_number, insurance_expiry, authority_status, safety_rating, liability_insurance, cargo_insurance, vehicle_oos_percent, driver_oos_percent
      FROM carriers
      WHERE status = 'active'
        AND (last_fmcsa_sync IS NULL OR last_fmcsa_sync < NOW() - INTERVAL '30 days')
      ORDER BY last_fmcsa_sync ASC NULLS FIRST
      LIMIT 50
    ` as Record<string, unknown>[]
  } catch (err) {
    console.error("[cron/fmcsa-reverify] Failed to query stale carriers:", err)
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }

  console.log(`[cron/fmcsa-reverify] Found ${staleCarriers.length} carrier(s) due for re-verification`)

  for (const carrier of staleCarriers) {
    const carrierId = carrier.id as string
    const dotNumber = carrier.dot_number as string | null

    try {
      if (!dotNumber) {
        console.log(`[cron/fmcsa-reverify] Carrier ${carrierId} (${carrier.company}) -- no DOT number, stamping sync time`)
        await sql`UPDATE carriers SET last_fmcsa_sync = NOW() WHERE id = ${carrierId}`
        processed++
        continue
      }

      console.log(`[cron/fmcsa-reverify] Verifying carrier ${carrierId} (${carrier.company}) DOT ${dotNumber}`)
      const fc = await fetchFmcsa(dotNumber, fmcsaKey)

      if (!fc) {
        console.warn(`[cron/fmcsa-reverify] No FMCSA data for carrier ${carrierId} (DOT ${dotNumber})`)
        await sql`UPDATE carriers SET last_fmcsa_sync = NOW() WHERE id = ${carrierId}`
        processed++
        await new Promise((r) => setTimeout(r, 200))
        continue
      }

      const authorityStatus = mapAuthorityStatus(fc.allowedToOperate)
      const safetyRating = mapSafetyRating(fc.safetyRating)
      const liabilityInsurance = fc.bipdInsuranceOnFile ?? (carrier.liability_insurance as number) ?? 0
      const cargoInsurance = fc.cargoInsuranceOnFile ?? (carrier.cargo_insurance as number) ?? 0
      const vehicleOos = fc.vehicleOosRate ?? (carrier.vehicle_oos_percent as number) ?? 0
      const driverOos = fc.driverOosRate ?? (carrier.driver_oos_percent as number) ?? 0

      await sql`
        UPDATE carriers SET authority_status = ${authorityStatus}, safety_rating = ${safetyRating}, liability_insurance = ${liabilityInsurance}, cargo_insurance = ${cargoInsurance}, vehicle_oos_percent = ${vehicleOos}, driver_oos_percent = ${driverOos}, last_fmcsa_sync = NOW(), updated_at = NOW() WHERE id = ${carrierId}
      `
      const alerts = buildAlerts(carrier, authorityStatus, safetyRating, vehicleOos, driverOos)
      await sql`
        UPDATE compliance_alerts SET resolved = true, resolved_at = NOW() WHERE carrier_id = ${carrierId} AND resolved = false
      `
      for (const alert of alerts) {
        await sql`
          INSERT INTO compliance_alerts (id, carrier_id, type, severity, title, description, detected_at, resolved) VALUES (${alertId()}, ${carrierId}, ${alert.type}, ${alert.severity}, ${alert.title}, ${alert.description}, NOW(), false)
        `
      }
      if (alerts.length > 0) { console.log(`[cron/fmcsa-reverify] Carrier ${carrierId} -- ${alerts.length} issue(s) found`) } else { console.log(`[cron/fmcsa-reverify] Carrier ${carrierId} -- compliant, no issues`) }
      processed++
    } catch (err) {
      const msg = `Carrier ${carrierId} (${carrier.company}): ${err instanceof Error ? err.message : String(err)}`
      console.error(`[cron/fmcsa-reverify] Error -- ${msg}`)
      errors.push(msg)
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  const summary = { processed, issues_found, errors }
  console.log(`[cron/fmcsa-reverify] Complete -- processed=${processed} issues_found=${issues_found} errors=${errors.length}`)
  return NextResponse.json(summary)
}
