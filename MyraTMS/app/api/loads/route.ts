import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { escapeLikeMeta } from "@/lib/escape-like"
import { executeWorkflows } from "@/lib/workflow-engine"

export async function GET(req: NextRequest) {
  const sql = getDb()
  const { searchParams } = req.nextUrl
  const status = searchParams.get("status")
  const search = searchParams.get("search")
  const limit = parseInt(searchParams.get("limit") || "100")
  const offset = parseInt(searchParams.get("offset") || "0")

  let rows
  if (status && search) {
    rows = await sql`SELECT * FROM loads WHERE status = ${status} AND (id ILIKE ${`%${escapeLikeMeta(search)}%`} OR origin ILIKE ${`%${escapeLikeMeta(search)}%`} OR destination ILIKE ${`%${escapeLikeMeta(search)}%`} OR shipper_name ILIKE ${`%${escapeLikeMeta(search)}%`}) ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
  } else if (status) {
    rows = await sql`SELECT * FROM loads WHERE status = ${status} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
  } else if (search) {
    rows = await sql`SELECT * FROM loads WHERE id ILIKE ${`%${escapeLikeMeta(search)}%`} OR origin ILIKE ${`%${escapeLikeMeta(search)}%`} OR destination ILIKE ${`%${escapeLikeMeta(search)}%`} OR shipper_name ILIKE ${`%${escapeLikeMeta(search)}%`} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
  } else {
    rows = await sql`SELECT * FROM loads ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
  }

  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const sql = getDb()
  const id = `LD-${Date.now().toString(36).toUpperCase()}`
  const margin = (body.revenue || 0) - (body.carrierCost || 0)
  const marginPercent = body.revenue > 0 ? Math.round((margin / body.revenue) * 100) : 0
  const assignedRep = `${user.firstName || ""} ${user.lastName || ""}`.trim()

  await sql`
    INSERT INTO loads (id, origin, destination, shipper_id, shipper_name, carrier_id, carrier_name, source, status, revenue, carrier_cost, margin, margin_percent, pickup_date, delivery_date, assigned_rep, equipment, weight)
    VALUES (${id}, ${body.origin}, ${body.destination}, ${body.shipperId || null}, ${body.shipperName || ""}, ${body.carrierId || null}, ${body.carrierName || ""}, ${body.source || "Load Board"}, ${body.status || "Booked"}, ${body.revenue || 0}, ${body.carrierCost || 0}, ${margin}, ${marginPercent}, ${body.pickupDate || null}, ${body.deliveryDate || null}, ${assignedRep}, ${body.equipment || ""}, ${body.weight || ""})
  `

  // Fire workflow engine for new load (non-blocking)
  executeWorkflows("load_created", {
    loadId: id,
    newStatus: body.status || "Booked",
    margin,
  }).catch((err) => console.error("[loads POST] workflow error:", err))

  return NextResponse.json({ id, ...body, margin, marginPercent }, { status: 201 })
}
