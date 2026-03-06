import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/auth"
import { getDb } from "@/lib/db"

// ---------------------------------------------------------------------------
// PATCH /api/exceptions/:id
//
// Actions: 'acknowledge' or 'resolve'
// ---------------------------------------------------------------------------

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getCurrentUser(req)
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params
  const sql = getDb()

  try {
    const body = await req.json()
    const { action } = body as { action: string }

    if (action === "acknowledge") {
      const rows = await sql`
        UPDATE exceptions
        SET acknowledged_at = NOW(), status = 'acknowledged'
        WHERE id = ${id}
        RETURNING *
      `
      if (rows.length === 0) {
        return NextResponse.json({ error: "Exception not found" }, { status: 404 })
      }
      return NextResponse.json(rows[0])
    }

    if (action === "resolve") {
      const rows = await sql`
        UPDATE exceptions
        SET resolved_at = NOW(), status = 'resolved'
        WHERE id = ${id}
        RETURNING *
      `
      if (rows.length === 0) {
        return NextResponse.json({ error: "Exception not found" }, { status: 404 })
      }

      const exc = rows[0]
      if (exc.load_id) {
        const others = await sql`
          SELECT 1 FROM exceptions
          WHERE load_id = ${exc.load_id} AND status = 'active' AND id != ${id}
          LIMIT 1
        `
        if (others.length === 0) {
          await sql`UPDATE loads SET has_exception = false WHERE id = ${exc.load_id}`
        }
      }

      return NextResponse.json(exc)
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 })
  } catch (err) {
    console.error("[PATCH /api/exceptions/:id] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
