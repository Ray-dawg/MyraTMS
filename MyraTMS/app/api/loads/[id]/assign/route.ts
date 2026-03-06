import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: loadId } = await params
    const body = await req.json()
    const {
      carrier_id,
      driver_id,
      carrier_rate,
      match_score,
      assignment_method = "matched",
    } = body

    if (!carrier_id) {
      return NextResponse.json({ error: "carrier_id is required" }, { status: 400 })
    }

    const sql = getDb()

    // Verify load exists
    const loads = await sql`SELECT id, status, revenue FROM loads WHERE id = ${loadId}`
    if (loads.length === 0) {
      return NextResponse.json({ error: "Load not found" }, { status: 404 })
    }

    // Verify carrier exists
    const carriers = await sql`SELECT id, company FROM carriers WHERE id = ${carrier_id}`
    if (carriers.length === 0) {
      return NextResponse.json({ error: "Carrier not found" }, { status: 404 })
    }

    const carrierName = carriers[0].company as string

    // Calculate margin if carrier_rate provided
    const revenue = Number(loads[0].revenue) || 0
    const carrierCost = carrier_rate || 0
    const margin = revenue - carrierCost
    const marginPercent = revenue > 0 ? Math.round((margin / revenue) * 100) : 0

    // Update the load with carrier assignment
    await sql`
      UPDATE loads SET
        carrier_id = ${carrier_id},
        carrier_name = ${carrierName},
        carrier_cost = ${carrierCost || null},
        margin = ${margin || null},
        margin_percent = ${marginPercent || null},
        driver_id = ${driver_id || null},
        status = CASE WHEN status = 'Booked' THEN 'Dispatched' ELSE status END,
        updated_at = NOW()
      WHERE id = ${loadId}
    `

    // Mark this carrier as selected in match_results
    if (match_score != null) {
      await sql`
        UPDATE match_results
        SET was_selected = TRUE
        WHERE load_id = ${loadId} AND carrier_id = ${carrier_id}
      `.catch(() => {})
    }

    // If driver assigned, update driver status
    if (driver_id) {
      await sql`
        UPDATE drivers SET status = 'on_load', updated_at = NOW()
        WHERE id = ${driver_id}
      `.catch(() => {})
    }

    return NextResponse.json({
      load_id: loadId,
      carrier_id,
      carrier_name: carrierName,
      assignment_method,
      status: "assigned",
    })
  } catch (err) {
    console.error("Assign error:", err)
    return NextResponse.json({ error: "Assignment failed" }, { status: 500 })
  }
}
