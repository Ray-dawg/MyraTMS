import { NextRequest, NextResponse } from "next/server"
import { withTenant, resolveTrackingToken } from "@/lib/db/tenant-context"
import { apiError } from "@/lib/api-error"

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const resolved = await resolveTrackingToken(token)
  if (!resolved) return apiError("Tracking token not found", 404)

  const events = await withTenant(resolved.tenantId, async (client) => {
    const { rows: tokens } = await client.query(
      `SELECT load_id, expires_at FROM tracking_tokens WHERE token = $1 LIMIT 1`,
      [token],
    )
    if (tokens.length === 0) return null
    if (tokens[0].expires_at && new Date(tokens[0].expires_at) < new Date()) {
      return { expired: true as const }
    }
    const { rows } = await client.query(
      `SELECT id, event_type, status, location, note, created_at
         FROM load_events
        WHERE load_id = $1
        ORDER BY created_at DESC`,
      [tokens[0].load_id],
    )
    return rows
  })

  if (!events) return apiError("Tracking token not found", 404)
  if ("expired" in events) return apiError("Tracking token has expired", 410)
  return NextResponse.json(events)
}
