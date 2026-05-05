import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)

  const rows = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM workflows ORDER BY created_at DESC`,
    )
    return rows
  })
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)

  const body = await req.json()
  const { name, description, triggerType, triggerConfig, conditions, actions, active } = body
  if (!name || !triggerType) return apiError("Name and trigger type are required", 400)

  const id = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO workflows (
         name, description, trigger_type, trigger_config, conditions, actions, active, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8
       )
       RETURNING id`,
      [
        name,
        description || "",
        triggerType,
        triggerConfig || null,
        JSON.stringify(conditions || []),
        JSON.stringify(actions || []),
        active !== false,
        `${user.firstName} ${user.lastName}`,
      ],
    )
    return rows[0].id
  })

  return NextResponse.json({ id }, { status: 201 })
}
