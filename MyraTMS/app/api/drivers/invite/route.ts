import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import crypto from "crypto"

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  if (!["admin", "dispatcher"].includes(user.role)) {
    return apiError("Forbidden", 403)
  }

  try {
    const body = await req.json()
    const { carrierId, loadId, firstName, lastName, phone, email } = body

    if (!carrierId || !loadId || !firstName || !lastName || !phone) {
      return NextResponse.json(
        { error: "carrierId, loadId, firstName, lastName, and phone are required" },
        { status: 400 }
      )
    }

    const sql = getDb()

    // Validate load exists and belongs to the specified carrier
    const loadRows = await sql`SELECT id, carrier_id FROM loads WHERE id = ${loadId}`
    if (loadRows.length === 0) {
      return apiError("Load not found", 404)
    }
    const load = loadRows[0] as any
    // Non-admin users may only invite drivers for loads assigned to their carrier
    if (user.role !== "admin" && load.carrier_id && load.carrier_id !== carrierId) {
      return apiError("Forbidden: load does not belong to this carrier", 403)
    }

    const driverId = crypto.randomUUID()

    // Create driver with pending_invite status
    await sql`
      INSERT INTO drivers (id, carrier_id, first_name, last_name, phone, email, invite_status, invite_token, invited_at, status, created_at)
      VALUES (
        ${driverId},
        ${carrierId},
        ${firstName},
        ${lastName},
        ${phone},
        ${email || null},
        'pending_invite',
        gen_random_uuid(),
        now(),
        'available',
        now()
      )
    `

    // Assign driver to load
    await sql`UPDATE loads SET driver_id = ${driverId} WHERE id = ${loadId}`

    // Fetch the created driver to get the generated invite_token
    const rows = await sql`SELECT invite_token FROM drivers WHERE id = ${driverId}`
    const inviteToken = rows[0].invite_token as string

    // Build invite URL
    const baseUrl = process.env.NEXT_PUBLIC_DRIVER_APP_URL || "http://localhost:3001"
    const inviteUrl = `${baseUrl}/join/${inviteToken}`

    // Attempt SMS via Twilio if configured
    let smsSent = false
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) {
      try {
        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`
        const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")

        const smsBody = `You've been invited to track a load with Myra Logistics. Set up your driver account here: ${inviteUrl}`
        const smsParams = new URLSearchParams({
          To: phone,
          From: process.env.TWILIO_FROM_NUMBER,
          Body: smsBody,
        })

        const smsRes = await fetch(twilioUrl, {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: smsParams.toString(),
        })

        smsSent = smsRes.ok
      } catch (err) {
        console.error("Twilio SMS error:", err)
      }
    }

    return NextResponse.json({
      driverId,
      inviteToken,
      inviteUrl,
      smsSent,
    }, { status: 201 })
  } catch (error) {
    console.error("Invite driver error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
