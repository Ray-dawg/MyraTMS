import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { apiError } from "@/lib/api-error"

/**
 * GET /api/tracking/[token]
 * Public endpoint — no auth required. The token IS the auth.
 * Returns public shipment data. NO revenue, carrier_cost, margin, or margin_percent.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const sql = getDb()

  // Look up tracking token and join with loads, carriers, shippers
  const rows = await sql`
    SELECT
      t.load_id,
      t.expires_at,
      l.id AS load_id_check,
      l.reference_number,
      l.po_number,
      l.status,
      l.origin,
      l.destination,
      l.origin_lat,
      l.origin_lng,
      l.dest_lat,
      l.dest_lng,
      l.current_lat,
      l.current_lng,
      l.current_eta,
      l.pickup_date,
      l.delivery_date,
      l.commodity,
      l.weight,
      l.equipment,
      l.pod_url,
      l.carrier_name,
      l.shipper_name,
      l.carrier_id,
      l.shipper_id,
      l.driver_id,
      l.updated_at
    FROM tracking_tokens t
    JOIN loads l ON l.id = t.load_id
    WHERE t.token = ${token}
    LIMIT 1
  `

  if (rows.length === 0) {
    return apiError("Tracking token not found or expired", 404)
  }

  const row = rows[0]

  // Check expiry
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return apiError("Tracking token has expired", 410)
  }

  // Fetch driver info if assigned
  let driver: { firstName: string; phone: string } | null = null
  if (row.driver_id) {
    const drivers = await sql`
      SELECT first_name, phone FROM drivers WHERE id = ${row.driver_id} LIMIT 1
    `
    if (drivers.length > 0) {
      driver = {
        firstName: drivers[0].first_name,
        phone: drivers[0].phone,
      }
    }
  }

  // Fetch load events
  const events = await sql`
    SELECT id, event_type, status, location, note, created_at
    FROM load_events
    WHERE load_id = ${row.load_id}
    ORDER BY created_at DESC
  `

  // Parse origin / destination cities from the stored strings
  // Format is typically "City, ST" or "City, ST - Address"
  const originParts = (row.origin || "").split(",")
  const destParts = (row.destination || "").split(",")

  const isDelivered = row.status === "delivered" || row.status === "Delivered"

  const response = {
    loadNumber: row.load_id,
    referenceNumber: row.reference_number || null,
    poNumber: row.po_number || null,
    status: row.status,
    carrier: row.carrier_name || "",
    shipper: row.shipper_name || "",
    origin: {
      city: originParts[0]?.trim() || "",
      state: originParts[1]?.trim()?.split(" ")[0]?.split("-")[0]?.trim() || "",
      lat: row.origin_lat ? parseFloat(row.origin_lat) : null,
      lng: row.origin_lng ? parseFloat(row.origin_lng) : null,
      date: row.pickup_date || null,
    },
    destination: {
      city: destParts[0]?.trim() || "",
      state: destParts[1]?.trim()?.split(" ")[0]?.split("-")[0]?.trim() || "",
      lat: row.dest_lat ? parseFloat(row.dest_lat) : null,
      lng: row.dest_lng ? parseFloat(row.dest_lng) : null,
      date: row.delivery_date || null,
    },
    currentLat: row.current_lat ? parseFloat(row.current_lat) : null,
    currentLng: row.current_lng ? parseFloat(row.current_lng) : null,
    currentEta: row.current_eta || null,
    commodity: row.commodity || "",
    weight: row.weight || "",
    equipment: row.equipment || "",
    events: events.map((e: Record<string, unknown>) => ({
      id: e.id,
      eventType: e.event_type,
      status: e.status,
      location: e.location || "",
      note: e.note || "",
      createdAt: e.created_at,
    })),
    isDelivered,
    podUrl: row.pod_url || null,
    driver,
    lastUpdated: row.updated_at || new Date().toISOString(),
  }

  return NextResponse.json(response)
}
