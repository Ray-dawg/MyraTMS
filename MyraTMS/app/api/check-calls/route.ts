import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function GET(request: NextRequest) {
  const user = getCurrentUser(request)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(request)

  const loadId = request.nextUrl.searchParams.get("load_id")

  const rows = await withTenant(ctx.tenantId, async (client) => {
    if (loadId) {
      const { rows } = await client.query(
        `SELECT * FROM check_calls WHERE load_id = $1 ORDER BY created_at DESC`,
        [loadId],
      )
      return rows
    }
    const { rows } = await client.query(
      `SELECT * FROM check_calls ORDER BY created_at DESC LIMIT 100`,
    )
    return rows
  })

  return NextResponse.json(rows)
}

export async function POST(request: NextRequest) {
  const user = getCurrentUser(request)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(request)

  const body = await request.json()
  const { loadId, location, status, notes, nextCheckCall } = body
  if (!loadId) return apiError("loadId is required", 400)

  const result = await withTenant(ctx.tenantId, async (client) => {
    const { rows: loadRows } = await client.query(
      `SELECT id FROM loads WHERE id = $1 LIMIT 1`,
      [loadId],
    )
    if (loadRows.length === 0) return { notFound: true as const }

    const checkCallId = crypto.randomUUID()
    const eventId = crypto.randomUUID()
    const createdBy = `${user.firstName} ${user.lastName}`

    await client.query(
      `INSERT INTO check_calls (id, load_id, location, status, notes, next_check_call, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [checkCallId, loadId, location || null, status || null, notes || null, nextCheckCall || null, createdBy],
    )

    await client.query(
      `INSERT INTO load_events (id, load_id, event_type, status, location, note)
       VALUES ($1, $2, 'check_call', $3, $4, $5)`,
      [eventId, loadId, status || "Check Call", location || null, notes || null],
    )

    const { rows: created } = await client.query(
      `SELECT * FROM check_calls WHERE id = $1 LIMIT 1`,
      [checkCallId],
    )
    return { row: created[0] }
  })

  if ("notFound" in result) return apiError("Load not found", 404)
  return NextResponse.json(result.row, { status: 201 })
}
