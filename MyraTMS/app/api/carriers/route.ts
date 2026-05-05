import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { escapeLikeMeta } from "@/lib/escape-like"

export async function GET(req: NextRequest) {
  const ctx = requireTenantContext(req)
  const search = req.nextUrl.searchParams.get("search")

  const rows = await withTenant(ctx.tenantId, async (client) => {
    if (search) {
      const like = `%${escapeLikeMeta(search)}%`
      const { rows } = await client.query(
        `SELECT * FROM carriers
          WHERE company ILIKE $1 OR mc_number ILIKE $1 OR id ILIKE $1
          ORDER BY created_at DESC`,
        [like],
      )
      return rows
    }
    const { rows } = await client.query(
      `SELECT * FROM carriers ORDER BY created_at DESC`,
    )
    return rows
  })

  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const ctx = requireTenantContext(req)
  const body = await req.json()
  const id = `CAR-${Date.now().toString(36).toUpperCase()}`

  await withTenant(ctx.tenantId, async (client) => {
    await client.query(
      `INSERT INTO carriers (
         id, company, mc_number, dot_number, contact_name, contact_phone,
         lanes_covered, authority_status, insurance_expiry,
         liability_insurance, cargo_insurance, safety_rating
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
       )`,
      [
        id,
        body.company,
        body.mcNumber || "",
        body.dotNumber || "",
        body.contactName || "",
        body.contactPhone || "",
        body.lanesCovered || [],
        body.authorityStatus || "Active",
        body.insuranceExpiry || null,
        body.liabilityInsurance || 0,
        body.cargoInsurance || 0,
        body.safetyRating || "Not Rated",
      ],
    )
  })

  return NextResponse.json({ id }, { status: 201 })
}
