import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Only drivers can access this endpoint
  if (user.role !== "driver") {
    return NextResponse.json(
      { error: "This endpoint is for drivers only" },
      { status: 403 }
    )
  }

  const driverId = user.userId
  const sql = getDb()

  const rows = await sql`
    SELECT l.*, c.company as carrier_name
    FROM loads l
    LEFT JOIN carriers c ON l.carrier_id = c.id
    WHERE l.driver_id = ${driverId}
      AND l.status NOT IN ('delivered', 'cancelled', 'invoiced', 'paid')
    ORDER BY
      CASE l.status
        WHEN 'in_transit' THEN 1
        WHEN 'at_delivery' THEN 2
        WHEN 'at_pickup' THEN 3
        WHEN 'accepted' THEN 4
        WHEN 'assigned' THEN 5
        ELSE 6
      END,
      l.pickup_date ASC
  `

  // Strip financial data — drivers must not see broker margins/revenue
  const safe = rows.map((r: any) => {
    const { revenue, carrier_cost, margin, margin_percent, ...rest } = r
    return rest
  })
  return NextResponse.json(safe)
}
