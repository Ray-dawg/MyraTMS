import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { createToken } from "@/lib/auth"
import bcrypt from "bcryptjs"

export async function POST(req: NextRequest) {
  try {
    const { carrierCode, pin } = await req.json()

    if (!carrierCode || !pin) {
      return NextResponse.json(
        { error: "Carrier code and PIN are required" },
        { status: 400 }
      )
    }

    const sql = getDb()
    // Fetch by carrier only — PIN check in JS to support both plaintext (legacy) and bcrypt (invite flow)
    const rows = await sql`
      SELECT d.*, c.company as carrier_name
      FROM drivers d
      JOIN carriers c ON d.carrier_id = c.id
      WHERE (LOWER(c.id) = LOWER(${carrierCode}) OR LOWER(c.mc_number) = LOWER(${carrierCode}))
        AND d.app_pin IS NOT NULL
        AND (d.invite_status IN ('active', 'pending_invite') OR d.invite_status IS NULL)
    `

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Invalid carrier code or PIN" },
        { status: 401 }
      )
    }

    // Find the driver whose PIN matches — bcrypt hash (invite flow) or plaintext (legacy)
    let driver = null
    for (const row of rows) {
      const stored = row.app_pin as string
      const isHashed = stored.startsWith("$2b$") || stored.startsWith("$2a$")
      const match = isHashed
        ? await bcrypt.compare(String(pin), stored)
        : stored === String(pin)
      if (match) {
        driver = row
        break
      }
    }

    if (!driver) {
      return NextResponse.json(
        { error: "Invalid carrier code or PIN" },
        { status: 401 }
      )
    }

    const token = createToken(
      {
        userId: driver.id,
        email: "",
        role: "driver",
        firstName: driver.first_name,
        lastName: driver.last_name,
        carrierId: driver.carrier_id,
      },
      "72h"
    )

    const isProduction = process.env.NODE_ENV === "production"

    const response = NextResponse.json({
      token,
      driver: {
        id: driver.id,
        firstName: driver.first_name,
        lastName: driver.last_name,
        carrierId: driver.carrier_id,
        carrierName: driver.carrier_name,
      },
    })

    response.cookies.set("auth-token", token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/",
      maxAge: 259200, // 72 hours
    })

    return response
  } catch (error) {
    console.error("Driver login error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
