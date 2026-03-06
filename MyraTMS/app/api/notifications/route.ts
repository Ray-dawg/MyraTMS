import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"

export async function GET() {
  const sql = getDb()
  const rows = await sql`SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50`
  return NextResponse.json(rows)
}

export async function PATCH(req: NextRequest) {
  const body = await req.json()
  const sql = getDb()

  if (body.markAllRead) {
    await sql`UPDATE notifications SET read = true WHERE read = false`
  } else if (body.id) {
    await sql`UPDATE notifications SET read = true WHERE id = ${body.id}`
  }

  return NextResponse.json({ success: true })
}
