import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

// Whitelist of allowed camelCase → snake_case column mappings for shippers.
// (Pre-existing route applied a regex column-name derivation to user input,
// which was an unfixed SQL-injection vector. Closed by introducing this
// whitelist alongside the multi-tenant refactor.)
const ALLOWED_COLUMNS: Record<string, string> = {
  company: "company",
  industry: "industry",
  pipelineStage: "pipeline_stage",
  contractStatus: "contract_status",
  assignedRep: "assigned_rep",
  contactName: "contact_name",
  contactEmail: "contact_email",
  contactPhone: "contact_phone",
  conversionProbability: "conversion_probability",
  notes: "notes",
  riskFlag: "risk_flag",
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)
  const { id } = await params

  const row = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM shippers WHERE id = $1 LIMIT 1`,
      [id],
    )
    return rows[0] ?? null
  })
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json(row)
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
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
      `UPDATE shippers SET ${setString}, updated_at = now() WHERE id = $${values.length + 1}`,
      [...values, id],
    )
    const { rows } = await client.query(
      `SELECT * FROM shippers WHERE id = $1 LIMIT 1`,
      [id],
    )
    return rows[0] ?? null
  })

  return NextResponse.json(updated)
}
