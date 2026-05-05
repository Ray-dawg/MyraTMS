import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
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

  const ctx = requireTenantContext(req)

  try {
    const body = await req.json()
    const { carrierId, loadId, firstName, lastName, phone, email } = body

    if (!carrierId || !loadId || !firstName || !lastName || !phone) {
      return NextResponse.json(
        { error: "carrierId, loadId, firstName, lastName, and phone are required" },
        { status: 400 }
      )
    }

    type InviteResult =
      | { ok: false; error: string; status: number }
      | { ok: true; driverId: string; inviteToken: string }

    const result = await withTenant(ctx.tenantId, async (client): Promise<InviteResult> => {
      // Validate load exists in this tenant and belongs to the specified carrier
      const { rows: loadRows } = await client.query(
        `SELECT id, carrier_id FROM loads WHERE id = $1 LIMIT 1`,
        [loadId],
      )
      if (loadRows.length === 0) {
        return { ok: false, error: "Load not found", status: 404 }
      }
      const load = loadRows[0]
      if (user.role !== "admin" && load.carrier_id && load.carrier_id !== carrierId) {
        return { ok: false, error: "Forbidden: load does not belong to this carrier", status: 403 }
      }

      const driverId = crypto.randomUUID()

      await client.query(
        `INSERT INTO drivers (id, carrier_id, first_name, last_name, phone, email, invite_status, invite_token, invited_at, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending_invite', gen_random_uuid(), now(), 'available', now())`,
        [driverId, carrierId, firstName, lastName, phone, email || null],
      )

      await client.query(
        `UPDATE loads SET driver_id = $1 WHERE id = $2`,
        [driverId, loadId],
      )

      const { rows: tokenRows } = await client.query(
        `SELECT invite_token FROM drivers WHERE id = $1 LIMIT 1`,
        [driverId],
      )
      return { ok: true, driverId, inviteToken: String(tokenRows[0].invite_token) }
    })

    if (!result.ok) {
      return apiError(result.error, result.status)
    }

    const { driverId, inviteToken } = result

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
