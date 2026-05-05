import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"

const ALLOWED_COLUMNS: Record<string, string> = {
  firstName: "first_name",
  lastName: "last_name",
  phone: "phone",
  email: "email",
  appPin: "app_pin",
  status: "status",
  carrierId: "carrier_id",
  lastKnownLat: "last_known_lat",
  lastKnownLng: "last_known_lng",
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const ctx = requireTenantContext(req)
  const { id } = await params

  const row = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT d.*, c.company as carrier_name
         FROM drivers d
         LEFT JOIN carriers c ON d.carrier_id = c.id
        WHERE d.id = $1
        LIMIT 1`,
      [id],
    )
    return rows[0] ?? null
  })
  if (!row) return NextResponse.json({ error: "Driver not found" }, { status: 404 })
  return NextResponse.json(row)
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
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
      `UPDATE drivers SET ${setString}, updated_at = now() WHERE id = $${values.length + 1}`,
      [...values, id],
    )
    const { rows } = await client.query(
      `SELECT d.*, c.company as carrier_name
         FROM drivers d
         LEFT JOIN carriers c ON d.carrier_id = c.id
        WHERE d.id = $1
        LIMIT 1`,
      [id],
    )
    return rows[0] ?? null
  })

  if (!updated) return NextResponse.json({ error: "Driver not found" }, { status: 404 })
  return NextResponse.json(updated)
}
