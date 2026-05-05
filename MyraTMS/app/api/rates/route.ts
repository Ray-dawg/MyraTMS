import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function GET(req: NextRequest) {
  try {
    const ctx = requireTenantContext(req)
    const { searchParams } = req.nextUrl
    const search = searchParams.get("search")
    const equipmentType = searchParams.get("equipmentType")

    const conditions: string[] = ["source = 'manual'"]
    const values: unknown[] = []
    if (search) {
      conditions.push(`(origin_region ILIKE $${values.length + 1} OR dest_region ILIKE $${values.length + 1})`)
      values.push(`%${search}%`)
    }
    if (equipmentType && equipmentType !== "all") {
      conditions.push(`equipment_type = $${values.length + 1}`)
      values.push(equipmentType)
    }

    const where = `WHERE ${conditions.join(" AND ")}`
    const rows = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM rate_cache ${where} ORDER BY fetched_at DESC LIMIT 200`,
        values,
      )
      return rows
    })
    return NextResponse.json(rows)
  } catch (err) {
    console.error("[rates GET] error:", err)
    return apiError("Failed to fetch rates", 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = requireTenantContext(req)
    const body = await req.json()
    if (!body.originRegion || !body.destRegion || !body.equipmentType || !body.ratePerMile) {
      return apiError("originRegion, destRegion, equipmentType, and ratePerMile are required", 400)
    }

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    await withTenant(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO rate_cache (
           origin_region, dest_region, equipment_type, rate_per_mile,
           total_rate, source, source_detail, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'manual', $6, $7
         )`,
        [
          body.originRegion,
          body.destRegion,
          body.equipmentType,
          body.ratePerMile,
          body.totalRate || null,
          JSON.stringify(body.sourceNotes ? { notes: body.sourceNotes } : {}),
          expiresAt,
        ],
      )
    })

    return NextResponse.json({ success: true }, { status: 201 })
  } catch (err) {
    console.error("[rates POST] error:", err)
    return apiError("Failed to add rate", 500)
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const ctx = requireTenantContext(req)
    const id = req.nextUrl.searchParams.get("id")
    if (!id) return apiError("id parameter required", 400)

    await withTenant(ctx.tenantId, async (client) => {
      await client.query(
        `DELETE FROM rate_cache WHERE id = $1::uuid AND source = 'manual'`,
        [id],
      )
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[rates DELETE] error:", err)
    return apiError("Failed to delete rate", 500)
  }
}
