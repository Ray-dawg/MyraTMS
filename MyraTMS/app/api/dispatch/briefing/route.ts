import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const sql = getDb()
  const dateParam = req.nextUrl.searchParams.get("date")

  // Validate date format if provided
  if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return apiError("Invalid date format. Use YYYY-MM-DD.")
  }

  // Use parameterized date or CURRENT_DATE
  const date = dateParam || new Date().toISOString().split("T")[0]

  const [pickups, deliveries, inTransitLoads, exceptions, uncovered, yesterday] =
    await Promise.all([
      // a) PICKUPS
      sql`
        SELECT id, reference_number, origin_city, origin, shipper_name, carrier_name,
               pickup_window_start, pickup_window_end, status,
               (status = 'Dispatched' AND pickup_date < CURRENT_DATE) AS is_late
        FROM loads
        WHERE pickup_date = ${date}::date
        ORDER BY pickup_window_start NULLS LAST
      `,

      // b) DELIVERIES
      sql`
        SELECT id, reference_number, dest_city, destination, shipper_name, carrier_name,
               delivery_window_start, current_eta, status,
               (current_eta IS NOT NULL AND current_eta > (delivery_date::timestamptz + interval '30 min')) AS is_late
        FROM loads
        WHERE delivery_date = ${date}::date
           OR (status = 'In Transit' AND current_eta::date = ${date}::date)
        ORDER BY delivery_window_start NULLS LAST, current_eta NULLS LAST
      `,

      // c) IN TRANSIT
      sql`
        SELECT id, reference_number, origin_city, dest_city,
               carrier_name, current_lat, current_lng, current_eta
        FROM loads
        WHERE status = 'In Transit'
      `,

      // d) EXCEPTIONS
      sql`
        SELECT e.id, e.type, e.severity, e.title, e.load_id, e.created_at
        FROM exceptions e
        WHERE e.status = 'active' AND e.severity IN ('critical', 'high')
        ORDER BY
          CASE e.severity WHEN 'critical' THEN 0 ELSE 1 END,
          e.created_at DESC
        LIMIT 10
      `,

      // e) UNCOVERED
      sql`
        SELECT id, reference_number, origin_city, dest_city, equipment, pickup_date, shipper_name
        FROM loads
        WHERE status = 'Booked'
          AND pickup_date BETWEEN ${date}::date AND ${date}::date + interval '2 days'
        ORDER BY pickup_date
      `,

      // f) YESTERDAY aggregates
      sql`
        SELECT
          COUNT(*)::int AS delivered_count,
          COUNT(CASE WHEN current_eta IS NULL OR current_eta <= delivery_date::timestamptz + interval '30 min' THEN 1 END)::int AS on_time_count,
          COALESCE(SUM(revenue), 0) AS total_revenue,
          COALESCE(SUM(margin), 0) AS total_margin,
          COALESCE(AVG(margin_percent), 0) AS avg_margin_pct
        FROM loads
        WHERE delivery_date = ${date}::date - 1
          AND status IN ('Delivered', 'Invoiced', 'Closed')
      `,
    ])

  const yesterdayRow = yesterday[0]
  const deliveredCount = Number(yesterdayRow.delivered_count)
  const onTimeCount = Number(yesterdayRow.on_time_count)

  return NextResponse.json({
    date,
    pickups,
    deliveries,
    inTransit: {
      count: inTransitLoads.length,
      loads: inTransitLoads,
    },
    exceptions,
    uncovered,
    yesterday: {
      deliveredCount,
      onTimeRate: deliveredCount > 0 ? onTimeCount / deliveredCount : 0,
      totalRevenue: Number(yesterdayRow.total_revenue),
      totalMargin: Number(yesterdayRow.total_margin),
      avgMarginPct: Number(Number(yesterdayRow.avg_margin_pct).toFixed(1)),
    },
  })
}
