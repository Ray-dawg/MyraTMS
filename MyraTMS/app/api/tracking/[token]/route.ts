import { NextRequest, NextResponse } from "next/server"
import { withTenant, resolveTrackingToken } from "@/lib/db/tenant-context"
import { apiError } from "@/lib/api-error"

/**
 * GET /api/tracking/[token]
 * Public endpoint — no auth required. Token IS the auth.
 *
 * Tenant resolution: tracking tokens cross authentication boundaries
 * (anonymous shipper user → carrier-tenant load), so the middleware does NOT
 * inject tenant context for these routes. Instead we use resolveTrackingToken
 * (which runs as service_admin and audits the lookup) to resolve the token
 * to a tenantId, then use withTenant for the per-tenant follow-up queries.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const resolved = await resolveTrackingToken(token)
  if (!resolved) {
    return apiError("Tracking token not found or expired", 404)
  }

  const data = await withTenant(resolved.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT
         t.load_id, t.expires_at,
         l.id AS load_id_check,
         l.reference_number, l.po_number, l.status,
         l.origin, l.destination,
         l.origin_lat, l.origin_lng, l.dest_lat, l.dest_lng,
         l.current_lat, l.current_lng, l.current_eta,
         l.pickup_date, l.delivery_date,
         l.commodity, l.weight, l.equipment, l.pod_url,
         l.carrier_name, l.shipper_name,
         l.carrier_id, l.shipper_id, l.driver_id,
         l.updated_at
         FROM tracking_tokens t
         JOIN loads l ON l.id = t.load_id
        WHERE t.token = $1
        LIMIT 1`,
      [token],
    )
    if (rows.length === 0) return null
    const row = rows[0]
    if (row.expires_at && new Date(row.expires_at) < new Date()) return { expired: true as const }

    let driver: { firstName: string; phone: string } | null = null
    if (row.driver_id) {
      const { rows: drivers } = await client.query(
        `SELECT first_name, phone FROM drivers WHERE id = $1 LIMIT 1`,
        [row.driver_id],
      )
      if (drivers.length > 0) {
        driver = { firstName: drivers[0].first_name, phone: drivers[0].phone }
      }
    }

    const { rows: events } = await client.query(
      `SELECT id, event_type, status, location, note, created_at
         FROM load_events
        WHERE load_id = $1
        ORDER BY created_at DESC`,
      [row.load_id],
    )

    return { row, driver, events }
  })

  if (!data) return apiError("Tracking token not found or expired", 404)
  if ("expired" in data) return apiError("Tracking token has expired", 410)

  const { row, driver, events } = data
  const originParts = (row.origin || "").split(",")
  const destParts = (row.destination || "").split(",")
  const isDelivered = row.status === "delivered" || row.status === "Delivered"

  return NextResponse.json({
    loadNumber: row.load_id,
    referenceNumber: row.reference_number || null,
    poNumber: row.po_number || null,
    status: row.status,
    carrier: row.carrier_name || "",
    shipper: row.shipper_name || "",
    origin: {
      city: originParts[0]?.trim() || "",
      state: originParts[1]?.trim()?.split(" ")[0]?.split("-")[0]?.trim() || "",
      lat: row.origin_lat ? Number.parseFloat(row.origin_lat) : null,
      lng: row.origin_lng ? Number.parseFloat(row.origin_lng) : null,
      date: row.pickup_date || null,
    },
    destination: {
      city: destParts[0]?.trim() || "",
      state: destParts[1]?.trim()?.split(" ")[0]?.split("-")[0]?.trim() || "",
      lat: row.dest_lat ? Number.parseFloat(row.dest_lat) : null,
      lng: row.dest_lng ? Number.parseFloat(row.dest_lng) : null,
      date: row.delivery_date || null,
    },
    currentLat: row.current_lat ? Number.parseFloat(row.current_lat) : null,
    currentLng: row.current_lng ? Number.parseFloat(row.current_lng) : null,
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
  })
}
