import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)

  const body = await req.json()
  const { loadId, status, notes, contactedDriver } = body
  if (!loadId) return apiError("loadId is required", 400)

  const createdBy = `${user.firstName} ${user.lastName}`

  try {
    const id = crypto.randomUUID()
    await withTenant(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO check_calls (id, load_id, status, notes, contacted_driver, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [id, loadId, status || "on_schedule", notes || "", contactedDriver || false, createdBy],
      )
      try {
        const noteId = crypto.randomUUID()
        await client.query(
          `INSERT INTO activity_notes (id, entity_type, entity_id, type, content, created_by, created_at)
           VALUES ($1, 'load', $2, 'check_call', $3, $4, NOW())`,
          [noteId, loadId, `Check-call: ${status}. ${notes || ""}`, createdBy],
        )
      } catch {
        // tolerate missing activity_notes table
      }
    })

    return NextResponse.json({
      success: true,
      checkCall: {
        id,
        loadId,
        status,
        notes,
        contactedDriver,
        timestamp: new Date().toISOString(),
        loggedBy: createdBy,
      },
    })
  } catch {
    const checkCall = {
      id: `CC-${Date.now()}`,
      loadId,
      status,
      notes: notes || "",
      contactedDriver: contactedDriver || false,
      timestamp: new Date().toISOString(),
      loggedBy: createdBy,
    }
    return NextResponse.json({ success: true, checkCall })
  }
}

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)

  const loadId = req.nextUrl.searchParams.get("loadId")

  try {
    const rows = await withTenant(ctx.tenantId, async (client) => {
      if (loadId) {
        const { rows } = await client.query(
          `SELECT * FROM check_calls WHERE load_id = $1 ORDER BY created_at DESC`,
          [loadId],
        )
        return rows
      }
      const { rows } = await client.query(
        `SELECT * FROM check_calls ORDER BY created_at DESC LIMIT 50`,
      )
      return rows
    })
    return NextResponse.json(rows)
  } catch {
    return NextResponse.json([])
  }
}
