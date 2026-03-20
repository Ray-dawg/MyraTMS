import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const sql = getDb()
  const weekStartParam = req.nextUrl.searchParams.get("weekStart")
  const repParam = req.nextUrl.searchParams.get("rep")

  // Validate date format if provided
  if (weekStartParam && !/^\d{4}-\d{2}-\d{2}$/.test(weekStartParam)) {
    return apiError("Invalid date format. Use YYYY-MM-DD.")
  }

  // Default to current Monday
  let weekStart = weekStartParam
  if (!weekStart) {
    const now = new Date()
    const day = now.getDay()
    const diff = day === 0 ? -6 : 1 - day
    const monday = new Date(now)
    monday.setDate(monday.getDate() + diff)
    weekStart = monday.toISOString().split("T")[0]
  }

  // weekEnd = weekStart + 6 days
  const wsDate = new Date(weekStart + "T12:00:00")
  const weDate = new Date(wsDate)
  weDate.setDate(weDate.getDate() + 6)
  const weekEnd = weDate.toISOString().split("T")[0]

  // Build events query with UNION ALL for pickups and deliveries
  let events
  if (repParam) {
    events = await sql`
      SELECT id AS load_id, reference_number, 'pickup' AS event_type,
             pickup_date AS event_date, origin_city, dest_city,
             carrier_name, status, assigned_rep
      FROM loads
      WHERE pickup_date::date BETWEEN ${weekStart}::date AND ${weekEnd}::date
        AND assigned_rep = ${repParam}
      UNION ALL
      SELECT id AS load_id, reference_number, 'delivery' AS event_type,
             delivery_date AS event_date, origin_city, dest_city,
             carrier_name, status, assigned_rep
      FROM loads
      WHERE delivery_date::date BETWEEN ${weekStart}::date AND ${weekEnd}::date
        AND assigned_rep = ${repParam}
      ORDER BY event_date
    `
  } else {
    events = await sql`
      SELECT id AS load_id, reference_number, 'pickup' AS event_type,
             pickup_date AS event_date, origin_city, dest_city,
             carrier_name, status, assigned_rep
      FROM loads
      WHERE pickup_date::date BETWEEN ${weekStart}::date AND ${weekEnd}::date
      UNION ALL
      SELECT id AS load_id, reference_number, 'delivery' AS event_type,
             delivery_date AS event_date, origin_city, dest_city,
             carrier_name, status, assigned_rep
      FROM loads
      WHERE delivery_date::date BETWEEN ${weekStart}::date AND ${weekEnd}::date
      ORDER BY event_date
    `
  }

  // Get distinct reps for filter dropdown
  const reps = await sql`
    SELECT DISTINCT assigned_rep
    FROM loads
    WHERE assigned_rep IS NOT NULL AND assigned_rep != ''
    ORDER BY assigned_rep
  `
  const availableReps = reps.map((r: { assigned_rep: string }) => r.assigned_rep)

  return NextResponse.json({ events, availableReps })
}
