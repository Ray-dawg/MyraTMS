import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { generateQuote } from "@/lib/quoting"
import { apiError } from "@/lib/api-error"

export async function POST(req: NextRequest) {
  try {
    const ctx = requireTenantContext(req)
    const body = await req.json()
    if (!body.origin || !body.destination) {
      return apiError("Origin and destination are required", 400)
    }

    const quote = await generateQuote({
      tenantId: ctx.tenantId,
      origin: body.origin,
      destination: body.destination,
      equipmentType: body.equipmentType || "dry_van",
      weightLbs: body.weightLbs,
      pickupDate: body.pickupDate,
      shipperId: body.shipperId,
      shipperName: body.shipperName,
      targetMargin: body.targetMargin !== undefined ? Number(body.targetMargin) : undefined,
      commodity: body.commodity,
    })

    return NextResponse.json(quote, { status: 201 })
  } catch (err) {
    console.error("[quotes POST] error:", err)
    const message = err instanceof Error ? err.message : "Failed to generate quote"
    return apiError(message, 500)
  }
}

export async function GET(req: NextRequest) {
  try {
    const ctx = requireTenantContext(req)
    const { searchParams } = req.nextUrl
    const status = searchParams.get("status")
    const shipperId = searchParams.get("shipperId")
    const confidenceLabel = searchParams.get("confidenceLabel")
    const search = searchParams.get("search")
    const limit = Number.parseInt(searchParams.get("limit") || "100")
    const offset = Number.parseInt(searchParams.get("offset") || "0")

    const conditions: string[] = []
    const values: unknown[] = []

    if (status && status !== "all") {
      conditions.push(`status = $${values.length + 1}`)
      values.push(status)
    }
    if (shipperId) {
      conditions.push(`shipper_id = $${values.length + 1}`)
      values.push(shipperId)
    }
    if (confidenceLabel) {
      conditions.push(`confidence_label = $${values.length + 1}`)
      values.push(confidenceLabel)
    }
    if (search) {
      conditions.push(
        `(reference ILIKE $${values.length + 1} OR origin_address ILIKE $${values.length + 1} OR dest_address ILIKE $${values.length + 1} OR shipper_name ILIKE $${values.length + 1})`,
      )
      values.push(`%${search}%`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    const query = `SELECT * FROM quotes ${where} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`
    values.push(limit, offset)

    const rows = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query(query, values)
      return rows
    })
    return NextResponse.json(rows)
  } catch (err) {
    console.error("[quotes GET] error:", err)
    return apiError("Failed to fetch quotes", 500)
  }
}
