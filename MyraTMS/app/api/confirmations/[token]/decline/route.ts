import { NextRequest, NextResponse } from "next/server"
import { apiError } from "@/lib/api-error"
import { declineConfirmation } from "@/lib/confirmation-actions"

/**
 * POST /api/confirmations/[token]/decline
 * Public endpoint — token IS the auth. Body: { reason?: string }.
 * Escalates to a human; terminal for the automated path.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const body = await request.json().catch(() => ({}))
  const reason: string | null = typeof body.reason === "string" ? body.reason.slice(0, 2000) : null

  const result = await declineConfirmation(token, reason)

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
    case "declined":
      return NextResponse.json({ outcome: result.outcome, loadId: result.loadId })
  }
}
