import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"

export async function GET(req: NextRequest) {
  const sql = getDb()
  const entityType = req.nextUrl.searchParams.get("entityType")
  const entityId = req.nextUrl.searchParams.get("entityId")

  if (!entityType || !entityId) {
    return NextResponse.json({ error: "entityType and entityId required" }, { status: 400 })
  }

  const rows = await sql`SELECT * FROM activity_notes WHERE entity_type = ${entityType} AND entity_id = ${entityId} ORDER BY created_at DESC`
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const sql = getDb()
  const createdBy = `${user.firstName || ""} ${user.lastName || ""}`.trim()

  await sql`
    INSERT INTO activity_notes (entity_type, entity_id, note_type, content, contact_person, duration, created_by)
    VALUES (${body.entityType}, ${body.entityId}, ${body.noteType}, ${body.content}, ${body.contactPerson || ""}, ${body.duration || ""}, ${createdBy})
  `

  return NextResponse.json({ success: true }, { status: 201 })
}
