import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

// ---------------------------------------------------------------------------
// POST /api/loadboard/import
// Body: loadboard result object (origin, destination, rate, equipment, etc.)
// Inserts into loads table with source='Load Board', status='Booked'
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  let body: {
    origin?: string
    destination?: string
    rate?: number
    equipment?: string
    weight?: string
    pickup_date?: string
    delivery_date?: string
    shipper_name?: string
    commodity?: string
    miles?: number
    source_board?: string
    external_id?: string
  }
  try {
    body = await req.json()
  } catch {
    return apiError("Invalid JSON body")
  }

  const { origin, destination, rate, equipment } = body
  if (!origin || !destination) {
    return apiError("Missing required fields: origin, destination")
  }

  const sql = getDb()
  const id = `LD-${Date.now().toString(36).toUpperCase()}`
  const assignedRep = `${user.firstName} ${user.lastName}`

  await sql`
    INSERT INTO loads (
      id, origin, destination, shipper, carrier, source, status,
      revenue, carrier_cost, margin, margin_percent,
      pickup_date, delivery_date, assigned_rep, equipment, weight,
      risk_flag, commodity
    )
    VALUES (
      ${id},
      ${origin},
      ${destination},
      ${body.shipper_name || "TBD"},
      ${"Unassigned"},
      ${"Load Board"},
      ${"Booked"},
      ${rate || 0},
      ${0},
      ${rate || 0},
      ${100},
      ${body.pickup_date || null},
      ${body.delivery_date || null},
      ${assignedRep},
      ${equipment || "Dry Van 53'"},
      ${body.weight || "N/A"},
      ${false},
      ${body.commodity || null}
    )
  `

  return NextResponse.json({
    success: true,
    load: {
      id,
      origin,
      destination,
      shipper: body.shipper_name || "TBD",
      carrier: "Unassigned",
      source: "Load Board",
      status: "Booked",
      revenue: rate || 0,
      carrier_cost: 0,
      margin: rate || 0,
      margin_percent: 100,
      pickup_date: body.pickup_date,
      delivery_date: body.delivery_date,
      assigned_rep: assignedRep,
      equipment: equipment || "Dry Van 53'",
      weight: body.weight || "N/A",
      imported_from: body.source_board || "Unknown",
      external_id: body.external_id || null,
    },
  }, { status: 201 })
}
