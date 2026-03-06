import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const sql = getDb()
  const rows = await sql`SELECT * FROM workflows ORDER BY created_at DESC`
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const body = await req.json()
  const { name, description, triggerType, triggerConfig, conditions, actions, active } = body

  if (!name || !triggerType) {
    return apiError("Name and trigger type are required", 400)
  }

  const sql = getDb()

  const rows = await sql`
    INSERT INTO workflows (name, description, trigger_type, trigger_config, conditions, actions, active, created_by)
    VALUES (
      ${name},
      ${description || ""},
      ${triggerType},
      ${triggerConfig || null},
      ${JSON.stringify(conditions || [])},
      ${JSON.stringify(actions || [])},
      ${active !== false},
      ${`${user.firstName} ${user.lastName}`}
    )
    RETURNING id
  `

  return NextResponse.json({ id: rows[0].id }, { status: 201 })
}
