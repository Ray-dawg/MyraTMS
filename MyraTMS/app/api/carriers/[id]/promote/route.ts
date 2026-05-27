import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireRole, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

/**
 * Promote a 'prospect' carrier to 'active'.
 *
 * The Ranker (Agent 4) matches both prospect and active carriers so the
 * matching engine has depth from FMCSA-seeded prospects. The Dispatcher
 * (Agent 7) refuses to dispatch to prospects — assignment requires 'active'.
 * Promotion happens here after a human operator has actually established
 * the carrier relationship (called them, signed paperwork, etc.).
 *
 * Logged to compliance_audit with the operator's user id for audit trail.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const denied = requireRole(user, "admin", "owner", "service_admin")
  if (denied) return denied

  const ctx = requireTenantContext(req)
  const { id } = await params

  const result = await withTenant(ctx.tenantId, async (client) => {
    const before = await client.query<{ carrier_status: string; company: string; mc_number: string }>(
      `SELECT carrier_status, company, mc_number FROM carriers WHERE id = $1 LIMIT 1`,
      [id],
    )
    if (before.rows.length === 0) return { status: 404 as const, body: { error: "Carrier not found" } }

    const prior = before.rows[0]
    if (prior.carrier_status === "active") {
      return { status: 409 as const, body: { error: "Carrier is already active", carrier_status: "active" } }
    }
    if (prior.carrier_status !== "prospect") {
      return { status: 409 as const, body: { error: `Cannot promote from carrier_status='${prior.carrier_status}'` } }
    }

    await client.query(
      `UPDATE carriers
         SET carrier_status = 'active', updated_at = NOW()
       WHERE id = $1`,
      [id],
    )

    await client.query(
      `INSERT INTO compliance_audit (check_type, result, details, checked_at)
       VALUES ('carrier_promote', 'success', $1, NOW())`,
      [
        JSON.stringify({
          carrier_id: id,
          company: prior.company,
          mc_number: prior.mc_number,
          from_status: prior.carrier_status,
          to_status: "active",
          tenant_id: ctx.tenantId,
          promoted_by_user_id: user.userId,
          promoted_by_role: user.role,
        }),
      ],
    )

    const after = await client.query(
      `SELECT * FROM carriers WHERE id = $1 LIMIT 1`,
      [id],
    )
    return { status: 200 as const, body: after.rows[0] }
  })

  return NextResponse.json(result.body, { status: result.status })
}
