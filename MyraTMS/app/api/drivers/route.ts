import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireRole, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import crypto from "crypto"

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const denied = requireRole(user, "admin", "ops", "sales")
  if (denied) return denied
  const ctx = requireTenantContext(req)

  const carrierId = req.nextUrl.searchParams.get("carrier_id")

  const rows = await withTenant(ctx.tenantId, async (client) => {
    if (carrierId) {
      const { rows } = await client.query(
        `SELECT d.*, c.company as carrier_name
           FROM drivers d
           LEFT JOIN carriers c ON d.carrier_id = c.id
          WHERE d.carrier_id = $1
          ORDER BY d.created_at DESC`,
        [carrierId],
      )
      return rows
    }
    const { rows } = await client.query(
      `SELECT d.*, c.company as carrier_name
         FROM drivers d
         LEFT JOIN carriers c ON d.carrier_id = c.id
        ORDER BY d.created_at DESC`,
    )
    return rows
  })

  // Strip sensitive fields (PINs are auth credentials)
  const safe = rows.map((r: Record<string, unknown>) => {
    const { app_pin: _appPin, ...rest } = r
    return rest
  })
  return NextResponse.json(safe)
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!["admin", "dispatcher"].includes(user.role)) return apiError("Forbidden", 403)
  const ctx = requireTenantContext(req)

  try {
    const body = await req.json()
    const { carrierId, firstName, lastName, phone, email, appPin } = body
    if (!carrierId || !firstName || !lastName || !appPin) {
      return NextResponse.json(
        { error: "carrierId, firstName, lastName, and appPin are required" },
        { status: 400 },
      )
    }

    const id = crypto.randomUUID()
    const created = await withTenant(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO drivers (id, carrier_id, first_name, last_name, phone, email, app_pin, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', now())`,
        [id, carrierId, firstName, lastName, phone || null, email || null, appPin],
      )
      const { rows } = await client.query(
        `SELECT d.*, c.company as carrier_name
           FROM drivers d
           LEFT JOIN carriers c ON d.carrier_id = c.id
          WHERE d.id = $1`,
        [id],
      )
      return rows[0]
    })

    const { app_pin: _appPin, ...safeDriver } = created as Record<string, unknown>
    return NextResponse.json(safeDriver, { status: 201 })
  } catch (error) {
    console.error("Create driver error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
