import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { escapeLikeMeta } from "@/lib/escape-like"

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const ctx = requireTenantContext(req)

  const { searchParams } = req.nextUrl
  const statuses = searchParams.getAll("status")
  const equipment = searchParams.get("equipment")
  const pickupAfter = searchParams.get("pickup_after")
  const pickupBefore = searchParams.get("pickup_before")

  const baseSelect = `SELECT
        l.id, l.reference_number, l.status, l.equipment,
        l.origin, l.destination, l.origin_city, l.dest_city,
        l.origin_lat, l.origin_lng, l.dest_lat, l.dest_lng,
        l.current_lat, l.current_lng, l.current_eta,
        l.shipper_name, l.carrier_name, l.has_exception,
        l.pickup_date, l.delivery_date, l.last_ping_at,
        d.first_name || ' ' || d.last_name as driver_name
      FROM loads l
      LEFT JOIN drivers d ON l.driver_id = d.id`

  const rows = await withTenant(ctx.tenantId, async (client) => {
    if (statuses.length > 0 && equipment && pickupAfter && pickupBefore) {
      const equipLike = `%${escapeLikeMeta(equipment)}%`
      return (
        await client.query(
          `${baseSelect}
           WHERE l.status = ANY($1::text[])
             AND l.equipment ILIKE $2
             AND l.pickup_date >= $3
             AND l.pickup_date <= $4
           ORDER BY l.pickup_date DESC
           LIMIT 500`,
          [statuses, equipLike, pickupAfter, pickupBefore],
        )
      ).rows
    }
    if (statuses.length > 0 && equipment) {
      const equipLike = `%${escapeLikeMeta(equipment)}%`
      return (
        await client.query(
          `${baseSelect}
           WHERE l.status = ANY($1::text[])
             AND l.equipment ILIKE $2
           ORDER BY l.pickup_date DESC
           LIMIT 500`,
          [statuses, equipLike],
        )
      ).rows
    }
    if (statuses.length > 0) {
      return (
        await client.query(
          `${baseSelect}
           WHERE l.status = ANY($1::text[])
           ORDER BY l.pickup_date DESC
           LIMIT 500`,
          [statuses],
        )
      ).rows
    }
    if (equipment) {
      const equipLike = `%${escapeLikeMeta(equipment)}%`
      return (
        await client.query(
          `${baseSelect}
           WHERE l.status NOT IN ('Closed')
             AND l.equipment ILIKE $1
           ORDER BY l.pickup_date DESC
           LIMIT 500`,
          [equipLike],
        )
      ).rows
    }
    return (
      await client.query(
        `${baseSelect}
         WHERE l.status NOT IN ('Closed')
         ORDER BY l.pickup_date DESC
         LIMIT 500`,
      )
    ).rows
  })

  const summary = {
    total: rows.length,
    booked: 0,
    dispatched: 0,
    in_transit: 0,
    delivered: 0,
    exceptions: 0,
  }
  for (const r of rows) {
    switch (r.status) {
      case "Booked":
        summary.booked++
        break
      case "Dispatched":
        summary.dispatched++
        break
      case "In Transit":
        summary.in_transit++
        break
      case "Delivered":
        summary.delivered++
        break
      case "Invoiced":
        summary.delivered++
        break
    }
    if (r.has_exception) summary.exceptions++
  }

  return NextResponse.json({ loads: rows, summary })
}
