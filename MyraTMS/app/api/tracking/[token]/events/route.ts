import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { apiError } from "@/lib/api-error"

/**
 * GET /api/tracking/[token]/events
 * Public endpoint — returns load events for the load linked to this token.
 * Events are ordered by created_at DESC (most recent first).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const sql = getDb()

  // Look up tracking token
  const tokens = await sql`
    SELECT load_id, expires_at FROM tracking_tokens
    WHERE token = ${token}
    LIMIT 1
  `

  if (tokens.length === 0) {
    return apiError("Tracking token not found", 404)
  }

  const { load_id, expires_at } = tokens[0]

  // Check expiry
  if (expires_at && new Date(expires_at) < new Date()) {
    return apiError("Tracking token has expired", 410)
  }

  // Fetch load events
  const events = await sql`
    SELECT id, event_type, status, location, note, created_at
    FROM load_events
    WHERE load_id = ${load_id}
    ORDER BY created_at DESC
  `

  return NextResponse.json(events)
}
