import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { apiError } from "@/lib/api-error"

export async function GET() {
  try {
    const sql = getDb()
    const rows = await sql`SELECT * FROM fuel_index ORDER BY effective_date DESC LIMIT 20`
    return NextResponse.json(rows)
  } catch (err) {
    console.error("[fuel-index GET] error:", err)
    return apiError("Failed to fetch fuel index", 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const sql = getDb()

    if (!body.pricePerLitre || !body.effectiveDate) {
      return apiError("pricePerLitre and effectiveDate are required", 400)
    }

    await sql`
      INSERT INTO fuel_index (source, price_per_litre, region, effective_date)
      VALUES (${body.source || "manual"}, ${body.pricePerLitre}, ${body.region || "Ontario"}, ${body.effectiveDate})
    `

    return NextResponse.json({ success: true }, { status: 201 })
  } catch (err) {
    console.error("[fuel-index POST] error:", err)
    return apiError("Failed to add fuel price", 500)
  }
}
