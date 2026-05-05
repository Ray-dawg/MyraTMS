import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = requireTenantContext(req)
  const { id } = await params
  const body = await req.json()

  const { actual_carrier_cost, load_id } = body
  if (!actual_carrier_cost) return apiError("actual_carrier_cost is required", 400)

  const result = await withTenant(ctx.tenantId, async (client) => {
    const { rows: quotes } = await client.query(
      `SELECT * FROM quotes WHERE id = $1 LIMIT 1`,
      [id],
    )
    if (quotes.length === 0) return null
    const quote = quotes[0]
    const accuracy =
      1 - Math.abs(Number(quote.carrier_cost_estimate) - actual_carrier_cost) / actual_carrier_cost

    await client.query(
      `UPDATE quotes
          SET actual_carrier_cost = $1,
              quote_accuracy = $2,
              load_id = $3,
              updated_at = NOW()
        WHERE id = $4`,
      [actual_carrier_cost, accuracy, load_id || quote.load_id, id],
    )
    return { accuracy }
  })

  if (!result) return apiError("Quote not found", 404)
  return NextResponse.json({ id, accuracy: result.accuracy, actualCarrierCost: actual_carrier_cost })
}
