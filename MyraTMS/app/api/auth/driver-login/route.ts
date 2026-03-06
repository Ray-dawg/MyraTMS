import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { createToken } from "@/lib/auth"

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
    const rows = await sql`
      SELECT d.*, c.company as carrier_name
      FROM drivers d
      JOIN carriers c ON d.carrier_id = c.id
      WHERE (c.id = ${carrierCode} OR c.mc_number = ${carrierCode})
        AND d.app_pin = ${pin}
    `

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Invalid carrier code or PIN" },
        { status: 401 }
      )
    }

    const driver = rows[0]

    const token = createToken(
      {
        userId: driver.id,
        email: "", // drivers may not have email
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
