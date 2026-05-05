import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { escapeLikeMeta } from "@/lib/escape-like"
import { executeWorkflows } from "@/lib/workflow-engine"

export async function GET(req: NextRequest) {
  const ctx = requireTenantContext(req)
  const { searchParams } = req.nextUrl
  const status = searchParams.get("status")
  const search = searchParams.get("search")
  const limit = Number.parseInt(searchParams.get("limit") || "100", 10)
  const offset = Number.parseInt(searchParams.get("offset") || "0", 10)

  const rows = await withTenant(ctx.tenantId, async (client) => {
    if (status && search) {
      const like = `%${escapeLikeMeta(search)}%`
      const { rows } = await client.query(
        `SELECT * FROM loads
          WHERE status = $1
            AND (id ILIKE $2 OR origin ILIKE $2 OR destination ILIKE $2 OR shipper_name ILIKE $2)
          ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [status, like, limit, offset],
      )
      return rows
    }
    if (status) {
      const { rows } = await client.query(
        `SELECT * FROM loads WHERE status = $1
          ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [status, limit, offset],
      )
      return rows
    }
    if (search) {
      const like = `%${escapeLikeMeta(search)}%`
      const { rows } = await client.query(
        `SELECT * FROM loads
          WHERE id ILIKE $1 OR origin ILIKE $1 OR destination ILIKE $1 OR shipper_name ILIKE $1
          ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [like, limit, offset],
      )
      return rows
    }
    const { rows } = await client.query(
      `SELECT * FROM loads ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    )
    return rows
  })

  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const ctx = requireTenantContext(req)
  const body = await req.json()
  const id = `LD-${Date.now().toString(36).toUpperCase()}`
  const margin = (body.revenue || 0) - (body.carrierCost || 0)
  const marginPercent = body.revenue > 0 ? Math.round((margin / body.revenue) * 100) : 0
  const assignedRep = `${body.assignedRep || ctx.userId || ""}`.trim()

  await withTenant(ctx.tenantId, async (client) => {
    await client.query(
      `INSERT INTO loads (
         id, origin, destination, shipper_id, shipper_name, carrier_id, carrier_name,
         source, status, revenue, carrier_cost, margin, margin_percent,
         pickup_date, delivery_date, assigned_rep, equipment, weight
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
       )`,
      [
        id,
        body.origin,
        body.destination,
        body.shipperId || null,
        body.shipperName || "",
        body.carrierId || null,
        body.carrierName || "",
        body.source || "Load Board",
        body.status || "Booked",
        body.revenue || 0,
        body.carrierCost || 0,
        margin,
        marginPercent,
        body.pickupDate || null,
        body.deliveryDate || null,
        assignedRep,
        body.equipment || "",
        body.weight || "",
      ],
    )
  })

  // Fire workflow engine for new load (non-blocking)
  executeWorkflows(ctx.tenantId, "load_created", {
    loadId: id,
    newStatus: body.status || "Booked",
    margin,
  }).catch((err) => console.error("[loads POST] workflow error:", err))

  return NextResponse.json({ id, ...body, margin, marginPercent }, { status: 201 })
}
