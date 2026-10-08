import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { asServiceAdmin } from "@/lib/db/tenant-context"
import { createToken, comparePassword } from "@/lib/auth"

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json()

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 }
      )
    }

    const sql = getDb()
    const rows = await sql`SELECT id, email, first_name, last_name, role, password_hash, is_super_admin FROM users WHERE email = ${email}`

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      )
    }

    const user = rows[0]
    const isValid = await comparePassword(password, user.password_hash)

    if (!isValid) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      )
    }

    // Resolve the user's primary tenant + the full set they belong to.
    // Backwards-compat: if no tenant_users rows exist (legacy DB pre-migration
    // 027), createToken's backfill defaults to LEGACY_DEFAULT_TENANT_ID = 2.
    //
    // Must run as service_admin: at login there is no tenant context yet, and
    // once RLS is enabled on tenant_users (Phase M3 day 2) a context-less read
    // returns zero rows - every login would silently fall back to tenant 2.
    // Found in the M3 pre-flight 2026-10-07.
    const tenantRows = await asServiceAdmin(
      "login: resolve tenant membership before any tenant context exists",
      async (client) => {
        const { rows } = await client.query<{ tenant_id: string | number; is_primary: boolean }>(
          `SELECT tenant_id, is_primary
             FROM tenant_users
            WHERE user_id = $1
            ORDER BY is_primary DESC, joined_at ASC`,
          [user.id],
        )
        return rows
      },
    )
    const allTenantIds = tenantRows.map((r) => Number(r.tenant_id))
    const primaryTenantId = tenantRows.find((r) => r.is_primary)?.tenant_id
    const tenantId = primaryTenantId !== undefined ? Number(primaryTenantId) : undefined
    const tenantIds = allTenantIds.length > 0 ? allTenantIds : undefined

    const token = createToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      firstName: user.first_name,
      lastName: user.last_name,
      tenantId,
      tenantIds,
      isSuperAdmin: user.is_super_admin === true,
    })

    const isProduction = process.env.NODE_ENV === "production"

    const response = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name,
      },
    })

    response.cookies.set("auth-token", token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/",
      maxAge: 86400, // 24 hours
    })

    return response
  } catch (error) {
    console.error("Login error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
