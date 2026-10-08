import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { ASSIGNABLE_REP_ROLES_SQL } from "@/lib/users/assignable-roles"

/**
 * GET /api/users — members of the caller's tenant (for rep pickers etc.).
 * Tenant-scoped explicitly via tenant_users.tenant_id (RLS is off). Only roles in
 * ASSIGNABLE_REP_ROLES are returned (drivers and any future roles are excluded).
 */
export async function GET(req: NextRequest) {
  const ctx = requireTenantContext(req)

  const rows = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT u.id, u.first_name, u.last_name, tu.role
         FROM tenant_users tu
         JOIN users u ON u.id = tu.user_id
        WHERE tu.tenant_id = $1
          AND ${ASSIGNABLE_REP_ROLES_SQL}
        ORDER BY u.first_name, u.last_name`,
      [ctx.tenantId],
    )
    return rows
  })

  return NextResponse.json(
    rows.map((r: Record<string, unknown>) => ({
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      role: r.role,
    })),
  )
}
