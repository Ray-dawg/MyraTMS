import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const { id } = await params
  const sql = getDb()
  const rows = await sql`SELECT * FROM workflows WHERE id = ${id}`

  if (rows.length === 0) return apiError("Workflow not found", 404)
  return NextResponse.json(rows[0])
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const { id } = await params
  const body = await req.json()
  const sql = getDb()

  // Check existence
  const existing = await sql`SELECT id FROM workflows WHERE id = ${id}`
  if (existing.length === 0) return apiError("Workflow not found", 404)

  // Build dynamic update
  if (body.name !== undefined) {
    await sql`UPDATE workflows SET name = ${body.name}, updated_at = NOW() WHERE id = ${id}`
  }
  if (body.description !== undefined) {
    await sql`UPDATE workflows SET description = ${body.description}, updated_at = NOW() WHERE id = ${id}`
  }
  if (body.active !== undefined) {
    await sql`UPDATE workflows SET active = ${body.active}, updated_at = NOW() WHERE id = ${id}`
  }
  if (body.triggerType !== undefined) {
    await sql`UPDATE workflows SET trigger_type = ${body.triggerType}, updated_at = NOW() WHERE id = ${id}`
  }
  if (body.triggerConfig !== undefined) {
    await sql`UPDATE workflows SET trigger_config = ${body.triggerConfig}, updated_at = NOW() WHERE id = ${id}`
  }
  if (body.conditions !== undefined) {
    await sql`UPDATE workflows SET conditions = ${JSON.stringify(body.conditions)}, updated_at = NOW() WHERE id = ${id}`
  }
  if (body.actions !== undefined) {
    await sql`UPDATE workflows SET actions = ${JSON.stringify(body.actions)}, updated_at = NOW() WHERE id = ${id}`
  }
  if (body.lastRun !== undefined) {
    await sql`UPDATE workflows SET last_run = ${body.lastRun}, updated_at = NOW() WHERE id = ${id}`
  }
  if (body.runsToday !== undefined) {
    await sql`UPDATE workflows SET runs_today = ${body.runsToday}, updated_at = NOW() WHERE id = ${id}`
  }

  const updated = await sql`SELECT * FROM workflows WHERE id = ${id}`
  return NextResponse.json(updated[0])
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const { id } = await params
  const sql = getDb()
  const existing = await sql`SELECT id FROM workflows WHERE id = ${id}`
  if (existing.length === 0) return apiError("Workflow not found", 404)

  await sql`DELETE FROM workflows WHERE id = ${id}`
  return NextResponse.json({ success: true })
}
