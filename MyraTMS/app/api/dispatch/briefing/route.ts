import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)

  const dateParam = req.nextUrl.searchParams.get("date")
  if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return apiError("Invalid date format. Use YYYY-MM-DD.")
  }
  const date = dateParam || new Date().toISOString().split("T")[0]

  const data = await withTenant(ctx.tenantId, async (client) => {
    const [pickups, deliveries, inTransit, exceptions, uncovered, yesterdayRows] = await Promise.all([
      client.query(
        `SELECT id, reference_number, origin_city, origin, shipper_name, carrier_name,
                pickup_window_start, pickup_window_end, status,
                (status = 'Dispatched' AND pickup_date < CURRENT_DATE) AS is_late
           FROM loads
          WHERE pickup_date = $1::date
          ORDER BY pickup_window_start NULLS LAST`,
        [date],
      ),
      client.query(
        `SELECT id, reference_number, dest_city, destination, shipper_name, carrier_name,
                delivery_window_start, current_eta, status,
                (current_eta IS NOT NULL AND current_eta > (delivery_date::timestamptz + interval '30 min')) AS is_late
           FROM loads
          WHERE delivery_date = $1::date
             OR (status = 'In Transit' AND current_eta::date = $1::date)
          ORDER BY delivery_window_start NULLS LAST, current_eta NULLS LAST`,
        [date],
      ),
      client.query(
        `SELECT id, reference_number, origin_city, dest_city,
                carrier_name, current_lat, current_lng, current_eta
           FROM loads WHERE status = 'In Transit'`,
      ),
      client.query(
        `SELECT e.id, e.type, e.severity, e.title, e.load_id, e.created_at
           FROM exceptions e
          WHERE e.status = 'active' AND e.severity IN ('critical', 'high')
          ORDER BY CASE e.severity WHEN 'critical' THEN 0 ELSE 1 END, e.created_at DESC
          LIMIT 10`,
      ),
      client.query(
        `SELECT id, reference_number, origin_city, dest_city, equipment, pickup_date, shipper_name
           FROM loads
          WHERE status = 'Booked'
            AND pickup_date BETWEEN $1::date AND $1::date + interval '2 days'
          ORDER BY pickup_date`,
        [date],
      ),
      client.query(
        `SELECT
           COUNT(*)::int AS delivered_count,
           COUNT(CASE WHEN current_eta IS NULL OR current_eta <= delivery_date::timestamptz + interval '30 min' THEN 1 END)::int AS on_time_count,
           COALESCE(SUM(revenue), 0) AS total_revenue,
           COALESCE(SUM(margin), 0) AS total_margin,
           COALESCE(AVG(margin_percent), 0) AS avg_margin_pct
           FROM loads
          WHERE delivery_date = $1::date - 1
            AND status IN ('Delivered', 'Invoiced', 'Closed')`,
        [date],
      ),
    ])

    return {
      pickups: pickups.rows,
      deliveries: deliveries.rows,
      inTransitLoads: inTransit.rows,
      exceptions: exceptions.rows,
      uncovered: uncovered.rows,
      yesterday: yesterdayRows.rows[0],
    }
  })

  const yesterdayRow = data.yesterday
  const deliveredCount = Number(yesterdayRow.delivered_count)
  const onTimeCount = Number(yesterdayRow.on_time_count)

  return NextResponse.json({
    date,
    pickups: data.pickups,
    deliveries: data.deliveries,
    inTransit: { count: data.inTransitLoads.length, loads: data.inTransitLoads },
    exceptions: data.exceptions,
    uncovered: data.uncovered,
    yesterday: {
      deliveredCount,
      onTimeRate: deliveredCount > 0 ? onTimeCount / deliveredCount : 0,
      totalRevenue: Number(yesterdayRow.total_revenue),
      totalMargin: Number(yesterdayRow.total_margin),
      avgMarginPct: Number(Number(yesterdayRow.avg_margin_pct).toFixed(1)),
    },
  })
}
