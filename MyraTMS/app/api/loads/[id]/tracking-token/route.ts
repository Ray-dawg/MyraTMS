import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

/**
 * POST /api/loads/[id]/tracking-token
 * Generate a 64-char hex tracking token for a load.
 * Auth-gated — only authenticated TMS users can generate tokens.
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
  const sql = getDb()

  // Verify load exists
  const loads = await sql`SELECT id FROM loads WHERE id = ${id} LIMIT 1`
  if (loads.length === 0) {
    return apiError("Load not found", 404)
  }

  // Check if a token already exists for this load
  const existing = await sql`
    SELECT token FROM tracking_tokens WHERE load_id = ${id} LIMIT 1
  `
  if (existing.length > 0) {
    const trackingBaseUrl = process.env.NEXT_PUBLIC_TRACKING_URL || (process.env.NODE_ENV === "development" ? "http://localhost:3002" : "")
    const trackingUrl = `${trackingBaseUrl}/track/${existing[0].token}`
    return NextResponse.json({
      token: existing[0].token,
      trackingUrl,
    })
  }

  // Generate 64-char hex token
  const token = crypto.randomBytes(32).toString("hex")
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days

  // Insert into tracking_tokens
  await sql`
    INSERT INTO tracking_tokens (id, load_id, token, expires_at)
    VALUES (${crypto.randomUUID()}, ${id}, ${token}, ${expiresAt.toISOString()})
  `

  // Also update the denormalized column on loads
  await sql`
    UPDATE loads SET tracking_token = ${token}, updated_at = now()
    WHERE id = ${id}
  `

  const trackingBaseUrl2 = process.env.NEXT_PUBLIC_TRACKING_URL || (process.env.NODE_ENV === "development" ? "http://localhost:3002" : "")
  const trackingUrl = `${trackingBaseUrl2}/track/${token}`

  return NextResponse.json({ token, trackingUrl }, { status: 201 })
}
