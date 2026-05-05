import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"

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

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = requireTenantContext(req)
  const { id } = await params

  const row = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM carriers WHERE id = $1 LIMIT 1`,
      [id],
    )
    return rows[0] ?? null
  })
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json(row)
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = requireTenantContext(req)
  const { id } = await params
  const body = await req.json()

  const setClauses: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(body)) {
    const col = ALLOWED_COLUMNS[key]
    if (!col) continue
    setClauses.push(`${col} = $${values.length + 1}`)
    values.push(value)
  }

  if (setClauses.length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 })
  }

  const updated = await withTenant(ctx.tenantId, async (client) => {
    const setString = setClauses.join(", ")
    await client.query(
      `UPDATE carriers SET ${setString}, updated_at = now() WHERE id = $${values.length + 1}`,
      [...values, id],
    )
    const { rows } = await client.query(
      `SELECT * FROM carriers WHERE id = $1 LIMIT 1`,
      [id],
    )
    return rows[0] ?? null
  })

  return NextResponse.json(updated)
}
