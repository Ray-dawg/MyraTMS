import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser, requireRole } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import crypto from "crypto"

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const denied = requireRole(user, "admin", "ops", "sales")
  if (denied) return denied

  const sql = getDb()
  const { searchParams } = req.nextUrl
  const carrierId = searchParams.get("carrier_id")

  let rows
  if (carrierId) {
    rows = await sql`
      SELECT d.*, c.company as carrier_name
      FROM drivers d
      LEFT JOIN carriers c ON d.carrier_id = c.id
      WHERE d.carrier_id = ${carrierId}
      ORDER BY d.created_at DESC
    `
  } else {
    rows = await sql`
      SELECT d.*, c.company as carrier_name
      FROM drivers d
      LEFT JOIN carriers c ON d.carrier_id = c.id
      ORDER BY d.created_at DESC
    `
  }

  // Strip sensitive fields (PINs are auth credentials)
  const safe = rows.map((r: any) => {
    const { app_pin, ...rest } = r
    return rest
  })
  return NextResponse.json(safe)
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (!["admin", "dispatcher"].includes(user.role)) {
    return apiError("Forbidden", 403)
  }

  try {
    const body = await req.json()
    const { carrierId, firstName, lastName, phone, email, appPin } = body

    if (!carrierId || !firstName || !lastName || !appPin) {
      return NextResponse.json(
        { error: "carrierId, firstName, lastName, and appPin are required" },
        { status: 400 }
      )
    }

    const sql = getDb()
    const id = crypto.randomUUID()

    await sql`
      INSERT INTO drivers (id, carrier_id, first_name, last_name, phone, email, app_pin, status, created_at)
      VALUES (${id}, ${carrierId}, ${firstName}, ${lastName}, ${phone || null}, ${email || null}, ${appPin}, 'active', now())
    `

    const rows = await sql`
      SELECT d.*, c.company as carrier_name
      FROM drivers d
      LEFT JOIN carriers c ON d.carrier_id = c.id
      WHERE d.id = ${id}
    `

    const { app_pin, ...safeDriver } = rows[0] as any
    return NextResponse.json(safeDriver, { status: 201 })
  } catch (error) {
    console.error("Create driver error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
