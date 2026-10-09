import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { escapeLikeMeta } from "@/lib/escape-like"
import { ASSIGNABLE_REP_ROLES_SQL } from "@/lib/users/assignable-roles"

export async function GET(req: NextRequest) {
  const ctx = requireTenantContext(req)
  const search = req.nextUrl.searchParams.get("search")

  const rows = await withTenant(ctx.tenantId, async (client) => {
    if (search) {
      const like = `%${escapeLikeMeta(search)}%`
      const { rows } = await client.query(
        `SELECT * FROM shippers
          WHERE company ILIKE $1 OR contact_name ILIKE $1 OR id ILIKE $1
          ORDER BY created_at DESC`,
        [like],
      )
      return rows
    }
    const { rows } = await client.query(
      `SELECT * FROM shippers ORDER BY created_at DESC`,
    )
    return rows
  })

  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const ctx = requireTenantContext(req)

  const body = await req.json()
  const id = `SHP-${Date.now().toString(36).toUpperCase()}`
  const defaultRep = `${user.firstName || ""} ${user.lastName || ""}`.trim()
  const requestedRep = typeof body.assignedRep === "string" ? body.assignedRep.trim() : ""

  const unknownRep = await withTenant(ctx.tenantId, async (client) => {
    // Stored format stays a display-name string. A requested rep must be an
    // assignable member of this tenant; no request falls back to the caller.
    let assignedRep = defaultRep
    if (requestedRep) {
      const { rows: match } = await client.query(
        `SELECT 1 FROM tenant_users tu
           JOIN users u ON u.id = tu.user_id
          WHERE tu.tenant_id = $1
            AND ${ASSIGNABLE_REP_ROLES_SQL}
            AND btrim(u.first_name || ' ' || u.last_name) = $2
          LIMIT 1`,
        [ctx.tenantId, requestedRep],
      )
      if (match.length === 0) return true
      assignedRep = requestedRep
    }
    await client.query(
      `INSERT INTO shippers (
         id, company, industry, pipeline_stage, contract_status, assigned_rep,
         contact_name, contact_email, contact_phone, conversion_probability
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
       )`,
      [
        id,
        body.company,
        body.industry || "",
        body.pipelineStage || "Prospect",
        body.contractStatus || "Prospect",
        assignedRep,
        body.contactName || "",
        body.contactEmail || "",
        body.contactPhone || "",
        body.conversionProbability || 0,
      ],
    )
    return false
  })

  if (unknownRep) return NextResponse.json({ error: "Unknown assigned rep" }, { status: 400 })

  return NextResponse.json({ id }, { status: 201 })
}
