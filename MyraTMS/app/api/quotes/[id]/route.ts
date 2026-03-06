import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { apiError } from "@/lib/api-error"

const ALLOWED_COLUMNS: Record<string, string> = {
  status: "status",
  shipperName: "shipper_name",
  shipperId: "shipper_id",
  validUntil: "valid_until",
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sql = getDb()
  const rows = await sql`SELECT * FROM quotes WHERE id = ${id} LIMIT 1`
  if (rows.length === 0) return apiError("Quote not found", 404)
  return NextResponse.json(rows[0])
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const sql = getDb()

  const setClauses: string[] = []
  const values: unknown[] = []

  for (const [key, value] of Object.entries(body)) {
    const col = ALLOWED_COLUMNS[key]
    if (!col) continue
    setClauses.push(`${col} = $${values.length + 1}`)
    values.push(value)
  }

  if (setClauses.length === 0) {
    return apiError("No valid fields to update", 400)
  }

  const setString = setClauses.join(", ")
  await sql.query(
    `UPDATE quotes SET ${setString}, updated_at = NOW() WHERE id = $${values.length + 1}`,
    [...values, id]
  )

  const rows = await sql`SELECT * FROM quotes WHERE id = ${id} LIMIT 1`
  if (rows.length === 0) return apiError("Quote not found", 404)
  return NextResponse.json(rows[0])
}
