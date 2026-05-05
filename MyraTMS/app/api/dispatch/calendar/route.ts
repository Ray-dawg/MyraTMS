import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)

  const weekStartParam = req.nextUrl.searchParams.get("weekStart")
  const repParam = req.nextUrl.searchParams.get("rep")

  if (weekStartParam && !/^\d{4}-\d{2}-\d{2}$/.test(weekStartParam)) {
    return apiError("Invalid date format. Use YYYY-MM-DD.")
  }

  let weekStart = weekStartParam
  if (!weekStart) {
    const now = new Date()
    const day = now.getDay()
    const diff = day === 0 ? -6 : 1 - day
    const monday = new Date(now)
    monday.setDate(monday.getDate() + diff)
    weekStart = monday.toISOString().split("T")[0]
  }

  const wsDate = new Date(weekStart + "T12:00:00")
  const weDate = new Date(wsDate)
  weDate.setDate(weDate.getDate() + 6)
  const weekEnd = weDate.toISOString().split("T")[0]

  const data = await withTenant(ctx.tenantId, async (client) => {
    const events = repParam
      ? (
          await client.query(
            `SELECT id AS load_id, reference_number, 'pickup' AS event_type,
                    pickup_date AS event_date, origin_city, dest_city,
                    carrier_name, status, assigned_rep
               FROM loads
              WHERE pickup_date::date BETWEEN $1::date AND $2::date
                AND assigned_rep = $3
              UNION ALL
             SELECT id AS load_id, reference_number, 'delivery' AS event_type,
                    delivery_date AS event_date, origin_city, dest_city,
                    carrier_name, status, assigned_rep
               FROM loads
              WHERE delivery_date::date BETWEEN $1::date AND $2::date
                AND assigned_rep = $3
              ORDER BY event_date`,
            [weekStart, weekEnd, repParam],
          )
        ).rows
      : (
          await client.query(
            `SELECT id AS load_id, reference_number, 'pickup' AS event_type,
                    pickup_date AS event_date, origin_city, dest_city,
                    carrier_name, status, assigned_rep
               FROM loads
              WHERE pickup_date::date BETWEEN $1::date AND $2::date
              UNION ALL
             SELECT id AS load_id, reference_number, 'delivery' AS event_type,
                    delivery_date AS event_date, origin_city, dest_city,
                    carrier_name, status, assigned_rep
               FROM loads
              WHERE delivery_date::date BETWEEN $1::date AND $2::date
              ORDER BY event_date`,
            [weekStart, weekEnd],
          )
        ).rows

    const { rows: reps } = await client.query(
      `SELECT DISTINCT assigned_rep FROM loads
        WHERE assigned_rep IS NOT NULL AND assigned_rep != ''
        ORDER BY assigned_rep`,
    )
    return { events, reps: reps.map((r: Record<string, unknown>) => r.assigned_rep as string) }
  })

  return NextResponse.json({ events: data.events, availableReps: data.reps })
}
