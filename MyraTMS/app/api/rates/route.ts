import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { apiError } from "@/lib/api-error"

export async function GET(req: NextRequest) {
  try {
    const sql = getDb()
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

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    const rows = await sql.query(
      `SELECT * FROM rate_cache ${where} ORDER BY fetched_at DESC LIMIT 200`,
      values
    )
    return NextResponse.json(rows)
  } catch (err) {
    console.error("[rates GET] error:", err)
    return apiError("Failed to fetch rates", 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const sql = getDb()

    if (!body.originRegion || !body.destRegion || !body.equipmentType || !body.ratePerMile) {
      return apiError("originRegion, destRegion, equipmentType, and ratePerMile are required", 400)
    }

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days

    await sql`
      INSERT INTO rate_cache (origin_region, dest_region, equipment_type, rate_per_mile, total_rate, source, source_detail, expires_at)
      VALUES (${body.originRegion}, ${body.destRegion}, ${body.equipmentType}, ${body.ratePerMile}, ${body.totalRate || null}, 'manual', ${JSON.stringify(body.sourceNotes ? { notes: body.sourceNotes } : {})}, ${expiresAt})
    `

    return NextResponse.json({ success: true }, { status: 201 })
  } catch (err) {
    console.error("[rates POST] error:", err)
    return apiError("Failed to add rate", 500)
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const sql = getDb()
    const id = req.nextUrl.searchParams.get("id")
    if (!id) return apiError("id parameter required", 400)

    await sql`DELETE FROM rate_cache WHERE id = ${id}::uuid AND source = 'manual'`
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("[rates DELETE] error:", err)
    return apiError("Failed to delete rate", 500)
  }
}
