import { NextRequest, NextResponse } from "next/server"
import { apiError } from "@/lib/api-error"
import { getConfirmationByToken } from "@/lib/confirmation-actions"

/**
 * GET /api/confirmations/[token]
 * Public endpoint — no auth required. Token IS the auth, same contract as
 * /api/tracking/[token]. The One_pager confirm-mode page tries this route
 * first and falls through to the tracking route on 404 (E2-04 M3 — same
 * standalone page serves both the rate-confirmation request link and the
 * post-dispatch tracking link).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const result = await getConfirmationByToken(token)

  if (!result.found) return apiError("Confirmation not found", 404)
  if (result.expired) return apiError("Confirmation link has expired", 410, { loadId: result.loadId })

  return NextResponse.json({
    loadId: result.loadId,
    stage: result.stage,
    alreadyResolved: result.alreadyResolved,
    snapshot: result.snapshot,
  })
}
