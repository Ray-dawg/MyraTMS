import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { sendTrackingEmail } from "@/lib/email"

/**
 * POST /api/loads/[id]/send-tracking
 * Auth-gated. Sends a tracking link to the specified email.
 * Body: { email: string, recipientName?: string }
 *
 * 1. Check if tracking token exists for load — if not, generate one
 * 2. Build tracking URL
 * 3. Try to send email (graceful fail if SMTP not configured)
 * 4. Return { success, trackingUrl, emailSent }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getCurrentUser(request)
  if (!user) {
    return apiError("Unauthorized", 401)
  }

  const { id } = await params
  const body = await request.json()
  const { email, recipientName } = body

  if (!email) {
    return apiError("email is required", 400)
  }

  const sql = getDb()

  // Verify load exists
  const loads = await sql`SELECT id, tracking_token FROM loads WHERE id = ${id} LIMIT 1`
  if (loads.length === 0) {
    return apiError("Load not found", 404)
  }

  let token = loads[0].tracking_token

  // If no tracking token exists, generate one
  if (!token) {
    token = crypto.randomBytes(32).toString("hex")
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days

    await sql`
      INSERT INTO tracking_tokens (id, load_id, token, expires_at)
      VALUES (${crypto.randomUUID()}, ${id}, ${token}, ${expiresAt.toISOString()})
    `

    await sql`
      UPDATE loads SET tracking_token = ${token}, updated_at = now()
      WHERE id = ${id}
    `
  }

  const trackingBaseUrl = process.env.NEXT_PUBLIC_TRACKING_URL || (process.env.NODE_ENV === "development" ? "http://localhost:3002" : "")
  const trackingUrl = `${trackingBaseUrl}/track/${token}`

  // Try to send email
  const emailSent = await sendTrackingEmail(
    email,
    trackingUrl,
    id,
    recipientName
  )

  return NextResponse.json({
    success: true,
    trackingUrl,
    emailSent,
  })
}
