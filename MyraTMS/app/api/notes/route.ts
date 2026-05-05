import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"

export async function GET(req: NextRequest) {
  const ctx = requireTenantContext(req)
  const entityType = req.nextUrl.searchParams.get("entityType")
  const entityId = req.nextUrl.searchParams.get("entityId")

  if (!entityType || !entityId) {
    return NextResponse.json({ error: "entityType and entityId required" }, { status: 400 })
  }

  const rows = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM activity_notes
        WHERE entity_type = $1 AND entity_id = $2
        ORDER BY created_at DESC`,
      [entityType, entityId],
    )
    return rows
  })
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const ctx = requireTenantContext(req)

  const body = await req.json()
  const createdBy = `${user.firstName || ""} ${user.lastName || ""}`.trim()

  await withTenant(ctx.tenantId, async (client) => {
    await client.query(
      `INSERT INTO activity_notes (
         entity_type, entity_id, note_type, content, contact_person, duration, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7
       )`,
      [
        body.entityType,
        body.entityId,
        body.noteType,
        body.content,
        body.contactPerson || "",
        body.duration || "",
        createdBy,
      ],
    )
  })

  return NextResponse.json({ success: true }, { status: 201 })
}
