import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { escapeLikeMeta } from "@/lib/escape-like"

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
  const assignedRep = `${user.firstName || ""} ${user.lastName || ""}`.trim()

  await withTenant(ctx.tenantId, async (client) => {
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
  })

  return NextResponse.json({ id }, { status: 201 })
}
