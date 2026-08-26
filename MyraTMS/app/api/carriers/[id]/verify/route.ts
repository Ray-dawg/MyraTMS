import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireRole, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { verifyCarrierAuthority, manuallyVerifyCarrier } from "@/lib/verification/carrier-verification"

/**
 * E2-03 M4 — Gate 2 carrier authority verification.
 *
 * Two paths, per PRD §8 ("populated by the lookup or a human confirmation"):
 *   - method: 'lookup'  — calls verifyCarrierAuthority() (E2-01's FMCSA/SAFER
 *                          chain, question flipped from "is this poster a
 *                          shipper" to "is this carrier's authority active").
 *                          Reports the result either way; does not itself
 *                          gate anything — /api/loads/[id]/assign is what
 *                          checks carriers.verified_at before a rate-con send.
 *   - method: 'manual'  — human override via manuallyVerifyCarrier(), for
 *                          carriers the automated lookup can't resolve (e.g.
 *                          small CVOR-only Canadian carriers). Logged to
 *                          compliance_audit like promote/route.ts's pattern
 *                          — a human bypassing the FMCSA check belongs in
 *                          the audit trail.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const denied = requireRole(user, "admin", "owner", "service_admin")
  if (denied) return denied

  const ctx = requireTenantContext(req)
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const method = body.method

  if (method !== "lookup" && method !== "manual") {
    return apiError("method must be 'lookup' or 'manual'", 400)
  }

  const exists = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query<{ id: string; company: string; mc_number: string }>(
      `SELECT id, company, mc_number FROM carriers WHERE id = $1 LIMIT 1`,
      [id],
    )
    return rows[0] ?? null
  })
  if (!exists) return apiError("Carrier not found", 404)

  if (method === "lookup") {
    try {
      const result = await verifyCarrierAuthority(id, { verifiedBy: `user:${user.userId}` })
      return NextResponse.json({
        carrier_id: id,
        verified: result.verified,
        reason: result.reason,
        entityClass: result.entityClass,
        legalNameMatch: result.legalNameMatch,
      })
    } catch (err) {
      return apiError(err instanceof Error ? err.message : "Verification lookup failed", 500)
    }
  }

  // method === 'manual'
  const notes: string | null = typeof body.notes === "string" ? body.notes : null
  const verifiedBy = `user:${user.userId}`

  await manuallyVerifyCarrier(id, { verifiedBy, notes })

  await withTenant(ctx.tenantId, async (client) => {
    await client.query(
      `INSERT INTO compliance_audit (check_type, result, details, checked_at)
       VALUES ('carrier_manual_verify', 'success', $1, NOW())`,
      [
        JSON.stringify({
          carrier_id: id,
          company: exists.company,
          mc_number: exists.mc_number,
          notes,
          tenant_id: ctx.tenantId,
          verified_by_user_id: user.userId,
          verified_by_role: user.role,
        }),
      ],
    )
  })

  return NextResponse.json({ carrier_id: id, verified: true, reason: null, verified_by: verifiedBy })
}
