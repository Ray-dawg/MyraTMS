import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { apiError } from "@/lib/api-error"

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sql = getDb()

  // Load the quote
  const quotes = await sql`SELECT * FROM quotes WHERE id = ${id} LIMIT 1`
  if (quotes.length === 0) return apiError("Quote not found", 404)

  const quote = quotes[0]
  if (!["draft", "accepted"].includes(quote.status)) {
    return apiError(`Cannot book a quote with status '${quote.status}'`, 400)
  }

  // Create a new load from the quote
  const loadId = `LD-${Date.now().toString(36).toUpperCase()}`

  await sql`
    INSERT INTO loads (
      id, origin, destination, shipper_id, shipper_name,
      equipment, weight, commodity, pickup_date,
      revenue, carrier_cost, margin, margin_percent,
      origin_lat, origin_lng, dest_lat, dest_lng,
      status, quote_id, source, created_at, updated_at
    ) VALUES (
      ${loadId}, ${quote.origin_address}, ${quote.dest_address},
      ${quote.shipper_id}, ${quote.shipper_name},
      ${quote.equipment_type}, ${String(quote.weight_lbs)}, ${quote.commodity}, ${quote.pickup_date},
      ${quote.shipper_rate}, ${quote.carrier_cost_estimate},
      ${quote.margin_dollars}, ${quote.margin_percent},
      ${quote.origin_lat}, ${quote.origin_lng}, ${quote.dest_lat}, ${quote.dest_lng},
      ${"Booked"}, ${id}, ${"Contract Shipper"}, NOW(), NOW()
    )
  `

  // Update quote status and link
  await sql`
    UPDATE quotes SET status = 'accepted', load_id = ${loadId}, updated_at = NOW()
    WHERE id = ${id}
  `

  return NextResponse.json({ loadId, quoteId: id, status: "created" }, { status: 201 })
}
