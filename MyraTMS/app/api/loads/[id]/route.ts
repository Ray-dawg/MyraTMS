import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { executeWorkflows } from "@/lib/workflow-engine"
import { processQuoteFeedback } from "@/lib/quoting/feedback"

// Whitelist of allowed camelCase → snake_case column mappings for loads
const ALLOWED_COLUMNS: Record<string, string> = {
  origin: "origin",
  destination: "destination",
  shipperId: "shipper_id",
  shipperName: "shipper_name",
  carrierId: "carrier_id",
  carrierName: "carrier_name",
  source: "source",
  status: "status",
  revenue: "revenue",
  carrierCost: "carrier_cost",
  margin: "margin",
  marginPercent: "margin_percent",
  pickupDate: "pickup_date",
  deliveryDate: "delivery_date",
  assignedRep: "assigned_rep",
  equipment: "equipment",
  weight: "weight",
  riskFlag: "risk_flag",
  // M1 tracking & geo columns
  driverId: "driver_id",
  trackingToken: "tracking_token",
  currentLat: "current_lat",
  currentLng: "current_lng",
  currentEta: "current_eta",
  originLat: "origin_lat",
  originLng: "origin_lng",
  destLat: "dest_lat",
  destLng: "dest_lng",
  podUrl: "pod_url",
  commodity: "commodity",
  poNumber: "po_number",
  referenceNumber: "reference_number",
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const { id } = await params
  const sql = getDb()
  const rows = await sql`SELECT * FROM loads WHERE id = ${id} LIMIT 1`
  if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const load = rows[0]

  // IDOR check: only admins/dispatchers can access any load
  if (user.role !== "admin" && user.role !== "dispatcher") {
    if (user.role === "shipper" && load.shipper_id !== (user as any).id) {
      return apiError("Forbidden", 403)
    }
    if (user.role === "carrier" && load.carrier_id !== (user as any).id) {
      return apiError("Forbidden", 403)
    }
  }

  return NextResponse.json(load)
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const { id } = await params
  const body = await req.json()
  const sql = getDb()

  // Build safe SET clause from whitelisted columns only
  const setClauses: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(body)) {
    const col = ALLOWED_COLUMNS[key]
    if (!col) continue // skip unknown fields
    setClauses.push(`${col} = $${values.length + 1}`)
    values.push(value)
  }

  if (setClauses.length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 })
  }

  // IDOR check: fetch the load first and verify the caller has access to it
  const existing = await sql`SELECT shipper_id, carrier_id FROM loads WHERE id = ${id} LIMIT 1`
  if (existing.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const existingLoad = existing[0]
  if (user.role !== "admin" && user.role !== "dispatcher") {
    if (user.role === "shipper" && existingLoad.shipper_id !== (user as any).id) {
      return apiError("Forbidden", 403)
    }
    if (user.role === "carrier" && existingLoad.carrier_id !== (user as any).id) {
      return apiError("Forbidden", 403)
    }
  }

  // Capture old status before update (for workflow triggers)
  let oldStatus: string | undefined
  if (body.status !== undefined) {
    const prev = await sql`SELECT status FROM loads WHERE id = ${id} LIMIT 1`
    if (prev.length > 0) oldStatus = prev[0].status
  }

  // Single atomic UPDATE with parameterized values
  // Column names are from our whitelist (safe), values are parameterized
  const setString = setClauses.join(", ")
  await sql.query(
    `UPDATE loads SET ${setString}, updated_at = now() WHERE id = $${values.length + 1}`,
    [...values, id]
  )

  // Fire workflow engine on status changes (non-blocking)
  if (body.status !== undefined && body.status !== oldStatus) {
    executeWorkflows("status_change", {
      loadId: id,
      oldStatus,
      newStatus: body.status,
    }).catch((err) => console.error("[loads PATCH] workflow error:", err))
  }

  // If load delivered and has a quote_id, trigger feedback loop
  if (body.status === "Delivered") {
    const loadRow = (await sql`SELECT quote_id, carrier_cost FROM loads WHERE id = ${id}`)[0]
    if (loadRow?.quote_id && loadRow?.carrier_cost) {
      processQuoteFeedback(loadRow.quote_id, Number(loadRow.carrier_cost), id)
        .catch((err) => console.error("[loads PATCH] quote feedback error:", err))
    }
  }

  const rows = await sql`SELECT * FROM loads WHERE id = ${id} LIMIT 1`
  return NextResponse.json(rows[0])
}
