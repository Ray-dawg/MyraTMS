import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { createToken, hashPassword } from "@/lib/auth"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { inviteToken, firstName, lastName, pin } = body

    if (!inviteToken || !firstName || !lastName || !pin) {
      return NextResponse.json(
        { error: "inviteToken, firstName, lastName, and pin are required" },
        { status: 400 }
      )
    }

    if (pin.length < 4) {
      return NextResponse.json(
        { error: "PIN must be at least 4 digits" },
        { status: 400 }
      )
    }

    const sql = getDb()

    // Find driver by invite token
    const drivers = await sql`
      SELECT d.*, c.company AS carrier_name
      FROM drivers d
      LEFT JOIN carriers c ON d.carrier_id = c.id
      WHERE d.invite_token = ${inviteToken}
        AND d.invite_status = 'pending_invite'
      LIMIT 1
    `

    if (drivers.length === 0) {
      return NextResponse.json(
        { error: "Invalid or already used invite" },
        { status: 404 }
      )
    }

    const driver = drivers[0]

    // Hash the PIN
    const hashedPin = await hashPassword(pin)

    // Update driver record
    await sql`
      UPDATE drivers
      SET app_pin = ${hashedPin},
          invite_status = 'active',
          invite_accepted_at = now(),
          first_name = ${firstName},
          last_name = ${lastName},
          updated_at = now()
      WHERE id = ${driver.id}
    `

    // Generate JWT
    const token = createToken(
      {
        userId: driver.id,
        email: driver.email || "",
        role: "driver",
        firstName,
        lastName,
        carrierId: driver.carrier_id,
      },
      "72h"
    )

    // Query the assigned load
    const loads = await sql`
      SELECT *
      FROM loads
      WHERE driver_id = ${driver.id}
        AND status NOT IN ('Delivered', 'Closed')
      ORDER BY created_at DESC
      LIMIT 1
    `

    return NextResponse.json({
      driverId: driver.id,
      authToken: token,
      driver: {
        id: driver.id,
        firstName,
        lastName,
        carrierId: driver.carrier_id,
        carrierName: driver.carrier_name,
      },
      assignedLoad: loads[0] || null,
    })
  } catch (error) {
    console.error("Accept invite error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
