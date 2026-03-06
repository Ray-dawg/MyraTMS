import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"

// Whitelist of allowed camelCase → snake_case column mappings for carriers
const ALLOWED_COLUMNS: Record<string, string> = {
  company: "company",
  mcNumber: "mc_number",
  dotNumber: "dot_number",
  insuranceStatus: "insurance_status",
  performanceScore: "performance_score",
  onTimePercent: "on_time_percent",
  lanesCovered: "lanes_covered",
  riskFlag: "risk_flag",
  contactName: "contact_name",
  contactPhone: "contact_phone",
  authorityStatus: "authority_status",
  insuranceExpiry: "insurance_expiry",
  liabilityInsurance: "liability_insurance",
  cargoInsurance: "cargo_insurance",
  safetyRating: "safety_rating",
  lastFmcsaSync: "last_fmcsa_sync",
  vehicleOosPercent: "vehicle_oos_percent",
  driverOosPercent: "driver_oos_percent",
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sql = getDb()
  const rows = await sql`SELECT * FROM carriers WHERE id = ${id} LIMIT 1`
  if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json(rows[0])
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const sql = getDb()

  // Build safe SET clause from whitelisted columns only
  const setClauses: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(body)) {
    const col = ALLOWED_COLUMNS[key]
    if (!col) continue // skip unknown fields
    setClauses.push(`${col} = $${values.length + 1}`)
    values.push(value)
  }

  if (setClauses.length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 })
  }

  // Single atomic UPDATE with parameterized values
  // Column names are from our whitelist (safe), values are parameterized
  const setString = setClauses.join(", ")
  await sql.query(
    `UPDATE carriers SET ${setString}, updated_at = now() WHERE id = $${values.length + 1}`,
    [...values, id]
  )

  const rows = await sql`SELECT * FROM carriers WHERE id = ${id} LIMIT 1`
  return NextResponse.json(rows[0])
}
