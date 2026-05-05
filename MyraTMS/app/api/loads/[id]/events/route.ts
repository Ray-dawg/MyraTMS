import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import crypto from "crypto"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const ctx = requireTenantContext(req)
  const { id: loadId } = await params

  const rows = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM load_events WHERE load_id = $1 ORDER BY created_at DESC`,
      [loadId],
    )
    return rows
  })

  return NextResponse.json(rows)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const ctx = requireTenantContext(req)
  const { id: loadId } = await params

  try {
    const body = await req.json()
    const { event_type, status, location, note } = body
    if (!event_type) {
      return NextResponse.json({ error: "event_type is required" }, { status: 400 })
    }

    const id = crypto.randomUUID()
    await withTenant(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO load_events (id, load_id, event_type, status, location, note, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [id, loadId, event_type, status || null, location || null, note || null, user.userId],
      )
    })

    return NextResponse.json({ id, loadId, event_type, status, note }, { status: 201 })
  } catch (error) {
    console.error("Create load event error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
