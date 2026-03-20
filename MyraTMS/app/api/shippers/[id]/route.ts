import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(_req)
  if (!user) return apiError("Unauthorized", 401)
  const { id } = await params
  const sql = getDb()
  const rows = await sql`SELECT * FROM shippers WHERE id = ${id} LIMIT 1`
  if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json(rows[0])
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const { id } = await params
  const body = await req.json()
  const sql = getDb()

  for (const [key, value] of Object.entries(body)) {
    const col = key.replace(/([A-Z])/g, "_$1").toLowerCase()
    await sql`UPDATE shippers SET ${sql.unsafe(col)} = ${value as string}, updated_at = now() WHERE id = ${id}`
  }

  const rows = await sql`SELECT * FROM shippers WHERE id = ${id} LIMIT 1`
  return NextResponse.json(rows[0])
}
