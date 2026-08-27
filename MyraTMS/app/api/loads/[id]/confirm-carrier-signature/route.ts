import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser, requireRole, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { completeDispatchOnSignedRateCon } from "@/lib/dispatch-gate"

/**
 * E2-04 review session — F1 (closes V1).
 *
 * POST /api/loads/[id]/confirm-carrier-signature
 *
 * Manual ops override for a carrier's signed rate confirmation, mirroring
 * /api/confirmations/[token]/verbal's role gate and shape on the shipper
 * side. Before this route existed, the ONLY caller of
 * completeDispatchOnSignedRateCon() was the IMAP poller's verified-carrier-
 * reply branch (lib/email/imap-poller.ts) -- with INBOUND_EMAIL_POLLING_ENABLED
 * defaulting false, 'Awaiting Signature' was a terminal state with no exit.
 * This is also the path for the first time a carrier faxes back or signs
 * in a portal instead of emailing, not just a stopgap for the poller being off.
 *
 * method: 'manual_ops' always -- this route can never claim 'email_verified',
 * which is reserved for the poller actually matching and verifying an
 * inbound reply. A manual override is weaker evidence and must stay
 * distinguishable in every downstream record from a verified one.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = getCurrentUser(request)
  if (!user) return apiError("Unauthorized", 401)

  const denied = requireRole(user, "admin", "owner", "service_admin")
  if (denied) return denied

  const ctx = requireTenantContext(request)
  const { id } = await params
  const body = await request.json().catch(() => ({}))

  const notes: string | null = typeof body.notes === "string" ? body.notes.slice(0, 2000) : null
  let signedPdfBuffer: Buffer | undefined
  let signedFileName: string | undefined
  if (typeof body.signedPdfBase64 === "string" && body.signedPdfBase64.length > 0) {
    try {
      signedPdfBuffer = Buffer.from(body.signedPdfBase64, "base64")
    } catch {
      return apiError("signedPdfBase64 is not valid base64", 400)
    }
    signedFileName = typeof body.signedFileName === "string" ? body.signedFileName.slice(0, 200) : undefined
  }

  const confirmedBy = `user:${user.userId}`

  const result = await completeDispatchOnSignedRateCon({
    tenantId: ctx.tenantId,
    loadId: id,
    method: "manual_ops",
    confirmedBy,
    notes: notes ?? undefined,
    signedPdfBuffer,
    signedFileName,
  })

  switch (result.outcome) {
    case "not_found":
      return apiError("Load not found", 404)
    case "not_awaiting_signature":
      return apiError("This load is not awaiting a carrier signature", 409, { status: result.status })
    case "dispatched":
      return NextResponse.json({
        load_id: id,
        status: "dispatched",
        confirmed_by: confirmedBy,
        method: "manual_ops",
        tracking_token: result.trackingToken,
      })
  }
}
