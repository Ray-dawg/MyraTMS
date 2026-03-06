import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params
    const sql = getDb()

    const rows = await sql`
      SELECT
        d.first_name,
        d.last_name,
        d.invite_status,
        c.company AS carrier_name,
        l.id AS load_id,
        l.origin,
        l.destination,
        l.pickup_date
      FROM drivers d
      LEFT JOIN carriers c ON d.carrier_id = c.id
      LEFT JOIN loads l ON l.driver_id = d.id AND l.status NOT IN ('Delivered', 'Closed')
      WHERE d.invite_token = ${token}
      LIMIT 1
    `

    if (rows.length === 0) {
      return NextResponse.json({ error: "Invalid or expired invite link" }, { status: 404 })
    }

    const row = rows[0]

    // Extract city from origin/destination (format: "City, ST" or full address)
    const originCity = row.origin ? String(row.origin).split(",")[0].trim() : ""
    const destCity = row.destination ? String(row.destination).split(",")[0].trim() : ""

    return NextResponse.json({
      firstName: row.first_name,
      lastName: row.last_name,
      carrierName: row.carrier_name,
      loadSummary: {
        reference: row.load_id,
        originCity,
        destCity,
        pickupDate: row.pickup_date,
      },
      status: row.invite_status === "pending_invite" ? "pending" : "accepted",
    })
  } catch (error) {
    console.error("Validate invite token error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
