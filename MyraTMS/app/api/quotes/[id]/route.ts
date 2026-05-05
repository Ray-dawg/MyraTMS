import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

const ALLOWED_COLUMNS: Record<string, string> = {
  status: "status",
  shipperName: "shipper_name",
  shipperId: "shipper_id",
  validUntil: "valid_until",
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = requireTenantContext(req)
  const { id } = await params

  const row = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(`SELECT * FROM quotes WHERE id = $1 LIMIT 1`, [id])
    return rows[0] ?? null
  })
  if (!row) return apiError("Quote not found", 404)
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
  if (setClauses.length === 0) return apiError("No valid fields to update", 400)

  const updated = await withTenant(ctx.tenantId, async (client) => {
    const setString = setClauses.join(", ")
    await client.query(
      `UPDATE quotes SET ${setString}, updated_at = NOW() WHERE id = $${values.length + 1}`,
      [...values, id],
    )
    const { rows } = await client.query(`SELECT * FROM quotes WHERE id = $1 LIMIT 1`, [id])
    return rows[0] ?? null
  })

  if (!updated) return apiError("Quote not found", 404)
  return NextResponse.json(updated)
}
