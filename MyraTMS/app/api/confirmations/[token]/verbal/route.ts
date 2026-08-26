import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser, requireRole } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { db } from "@/lib/pipeline/db-adapter"
import { recordVerbalConfirmation } from "@/lib/confirmation-actions"

/**
 * POST /api/confirmations/[token]/verbal
 * Authenticated ops route — NOT public (unlike the other 3 confirmation
 * routes). Records a confirmation an ops user obtained by phone when the
 * shipper won't use the web link, e.g. after the 2h timeout escalation.
 * Mirrors /api/carriers/[id]/verify's method:'manual' path (E2-03 M4) —
 * human override, logged to compliance_audit, same role gate.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const user = getCurrentUser(request)
  if (!user) return apiError("Unauthorized", 401)

  const denied = requireRole(user, "admin", "owner", "service_admin")
  if (denied) return denied

  const { token } = await params
  const body = await request.json().catch(() => ({}))
  const notes: string | null = typeof body.notes === "string" ? body.notes.slice(0, 2000) : null

  const row = await db.query<{ id: number }>(
    `SELECT id FROM pipeline_loads WHERE confirmation_token = $1`,
    [token],
  )
  if (row.rows.length === 0) return apiError("Confirmation not found", 404)

  const confirmedBy = `user:${user.userId}`
  const result = await recordVerbalConfirmation(row.rows[0].id, confirmedBy, notes)

  switch (result.outcome) {
    case "not_found":
      return apiError("Confirmation not found", 404)
    case "expired":
      return apiError("Confirmation link has expired", 410, { loadId: result.loadId })
    case "already_resolved":
      return apiError("This load is not eligible for a verbal confirmation", 409, {
        loadId: result.loadId,
        stage: result.stage,
      })
    case "already_confirmed":
      return NextResponse.json({ outcome: result.outcome, loadId: result.loadId })
    case "confirmed":
      return NextResponse.json({ outcome: result.outcome, loadId: result.loadId, confirmedBy })
  }
}
