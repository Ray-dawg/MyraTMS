import { NextRequest, NextResponse } from "next/server"
import { apiError } from "@/lib/api-error"
import { submitConfirmation } from "@/lib/confirmation-actions"

/**
 * POST /api/confirmations/[token]/confirm
 * Public endpoint — token IS the auth. Shipper clicks "Confirm This Load"
 * on the One_pager confirm-mode page. Idempotent: a repeat click after an
 * already-confirmed load returns 200 with outcome='already_confirmed'
 * rather than an error.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const result = await submitConfirmation(token)

  switch (result.outcome) {
    case "not_found":
      return apiError("Confirmation not found", 404)
    case "expired":
      return apiError("Confirmation link has expired", 410, { loadId: result.loadId })
    case "already_resolved":
      return apiError("This load is no longer awaiting confirmation", 409, {
        loadId: result.loadId,
        stage: result.stage,
      })
    case "already_confirmed":
      return NextResponse.json({ outcome: result.outcome, loadId: result.loadId })
    case "confirmed":
      return NextResponse.json({ outcome: result.outcome, loadId: result.loadId })
  }
}
