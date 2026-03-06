import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { apiError } from "@/lib/api-error"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const sql = getDb()

  const { actual_carrier_cost, load_id } = body
  if (!actual_carrier_cost) {
    return apiError("actual_carrier_cost is required", 400)
  }

  const quotes = await sql`SELECT * FROM quotes WHERE id = ${id} LIMIT 1`
  if (quotes.length === 0) return apiError("Quote not found", 404)

  const quote = quotes[0]
  const accuracy = 1 - Math.abs(Number(quote.carrier_cost_estimate) - actual_carrier_cost) / actual_carrier_cost

  await sql`
    UPDATE quotes
    SET actual_carrier_cost = ${actual_carrier_cost},
        quote_accuracy = ${accuracy},
        load_id = ${load_id || quote.load_id},
        updated_at = NOW()
    WHERE id = ${id}
  `

  return NextResponse.json({ id, accuracy, actualCarrierCost: actual_carrier_cost })
}
