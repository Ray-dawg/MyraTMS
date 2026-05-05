import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

const ALLOWED_COLUMNS: Record<string, { col: string; jsonStringify?: boolean }> = {
  name: { col: "name" },
  description: { col: "description" },
  active: { col: "active" },
  triggerType: { col: "trigger_type" },
  triggerConfig: { col: "trigger_config" },
  conditions: { col: "conditions", jsonStringify: true },
  actions: { col: "actions", jsonStringify: true },
  lastRun: { col: "last_run" },
  runsToday: { col: "runs_today" },
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)
  const { id } = await params

  const row = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM workflows WHERE id = $1`,
      [id],
    )
    return rows[0] ?? null
  })
  if (!row) return apiError("Workflow not found", 404)
  return NextResponse.json(row)
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)
  const { id } = await params
  const body = await req.json()

  const setClauses: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(body)) {
    const spec = ALLOWED_COLUMNS[key]
    if (!spec) continue
    setClauses.push(`${spec.col} = $${values.length + 1}`)
    values.push(spec.jsonStringify ? JSON.stringify(value) : value)
  }

  const updated = await withTenant(ctx.tenantId, async (client) => {
    const { rows: existing } = await client.query(
      `SELECT id FROM workflows WHERE id = $1`,
      [id],
    )
    if (existing.length === 0) return null

    if (setClauses.length > 0) {
      const setString = setClauses.join(", ")
      await client.query(
        `UPDATE workflows SET ${setString}, updated_at = NOW() WHERE id = $${values.length + 1}`,
        [...values, id],
      )
    }

    const { rows } = await client.query(
      `SELECT * FROM workflows WHERE id = $1`,
      [id],
    )
    return rows[0] ?? null
  })

  if (!updated) return apiError("Workflow not found", 404)
  return NextResponse.json(updated)
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)
  const { id } = await params

  const found = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id FROM workflows WHERE id = $1`,
      [id],
    )
    if (rows.length === 0) return false
    await client.query(`DELETE FROM workflows WHERE id = $1`, [id])
    return true
  })

  if (!found) return apiError("Workflow not found", 404)
  return NextResponse.json({ success: true })
}
