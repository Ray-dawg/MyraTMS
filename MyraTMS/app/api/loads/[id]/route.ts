import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
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
  const ctx = requireTenantContext(req)
  const { id } = await params

  const load = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(`SELECT * FROM loads WHERE id = $1 LIMIT 1`, [id])
    return rows[0] ?? null
  })
  if (!load) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // IDOR check: only admins/dispatchers can access any load
  if (user.role !== "admin" && user.role !== "dispatcher") {
    if (user.role === "shipper" && load.shipper_id !== (user as unknown as { id: string }).id) {
      return apiError("Forbidden", 403)
    }
    if (user.role === "carrier" && load.carrier_id !== (user as unknown as { id: string }).id) {
      return apiError("Forbidden", 403)
    }
  }

  return NextResponse.json(load)
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)
  const { id } = await params
  const body = await req.json()

  // Build safe SET clause from whitelisted columns only
  const setClauses: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(body)) {
    const col = ALLOWED_COLUMNS[key]
    if (!col) continue
    setClauses.push(`${col} = $${values.length + 1}`)
    values.push(value)
  }

  if (setClauses.length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 })
  }

  const result = await withTenant(ctx.tenantId, async (client) => {
    // IDOR check: fetch the load first and verify the caller has access to it
    const { rows: existing } = await client.query(
      `SELECT shipper_id, carrier_id, status FROM loads WHERE id = $1 LIMIT 1`,
      [id],
    )
    if (existing.length === 0) {
      return { notFound: true as const }
    }
    const existingLoad = existing[0]
    if (user.role !== "admin" && user.role !== "dispatcher") {
      if (user.role === "shipper" && existingLoad.shipper_id !== (user as unknown as { id: string }).id) {
        return { forbidden: true as const }
      }
      if (user.role === "carrier" && existingLoad.carrier_id !== (user as unknown as { id: string }).id) {
        return { forbidden: true as const }
      }
    }

    const oldStatus: string | undefined = existingLoad.status

    // Single atomic UPDATE with parameterized values
    const setString = setClauses.join(", ")
    await client.query(
      `UPDATE loads SET ${setString}, updated_at = now() WHERE id = $${values.length + 1}`,
      [...values, id],
    )

    const { rows: updated } = await client.query(
      `SELECT * FROM loads WHERE id = $1 LIMIT 1`,
      [id],
    )
    return { row: updated[0], oldStatus }
  })

  if ("notFound" in result) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if ("forbidden" in result) return apiError("Forbidden", 403)

  // Fire workflow engine on status changes (non-blocking)
  if (body.status !== undefined && body.status !== result.oldStatus) {
    executeWorkflows(ctx.tenantId, "status_change", {
      loadId: id,
      oldStatus: result.oldStatus,
      newStatus: body.status,
    }).catch((err) => console.error("[loads PATCH] workflow error:", err))
  }

  // If load delivered and has a quote_id, trigger feedback loop
  if (body.status === "Delivered" && result.row?.quote_id && result.row?.carrier_cost) {
    processQuoteFeedback(ctx.tenantId, result.row.quote_id, Number(result.row.carrier_cost), id)
      .catch((err) => console.error("[loads PATCH] quote feedback error:", err))
  }

  return NextResponse.json(result.row)
}
