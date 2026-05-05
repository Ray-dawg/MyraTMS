import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = requireTenantContext(req)
  const { id } = await params

  type BookResult =
    | { ok: true; loadId: string }
    | { ok: false; status: number; error: string }

  const result = await withTenant(ctx.tenantId, async (client): Promise<BookResult> => {
    const { rows: quotes } = await client.query(
      `SELECT * FROM quotes WHERE id = $1 LIMIT 1`,
      [id],
    )
    if (quotes.length === 0) return { ok: false, status: 404, error: "Quote not found" }
    const quote = quotes[0]
    if (!["draft", "accepted"].includes(quote.status)) {
      return { ok: false, status: 400, error: `Cannot book a quote with status '${quote.status}'` }
    }

    const loadId = `LD-${Date.now().toString(36).toUpperCase()}`

    await client.query(
      `INSERT INTO loads (
         id, origin, destination, shipper_id, shipper_name,
         equipment, weight, commodity, pickup_date,
         revenue, carrier_cost, margin, margin_percent,
         origin_lat, origin_lng, dest_lat, dest_lng,
         status, quote_id, source, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, 'Booked', $18, 'Contract Shipper', NOW(), NOW()
       )`,
      [
        loadId,
        quote.origin_address,
        quote.dest_address,
        quote.shipper_id,
        quote.shipper_name,
        quote.equipment_type,
        String(quote.weight_lbs),
        quote.commodity,
        quote.pickup_date,
        quote.shipper_rate,
        quote.carrier_cost_estimate,
        quote.margin_dollars,
        quote.margin_percent,
        quote.origin_lat,
        quote.origin_lng,
        quote.dest_lat,
        quote.dest_lng,
        id,
      ],
    )

    await client.query(
      `UPDATE quotes SET status = 'accepted', load_id = $1, updated_at = NOW()
        WHERE id = $2`,
      [loadId, id],
    )

    return { ok: true, loadId }
  })

  if (!result.ok) return apiError(result.error, result.status)
  return NextResponse.json({ loadId: result.loadId, quoteId: id, status: "created" }, { status: 201 })
}
