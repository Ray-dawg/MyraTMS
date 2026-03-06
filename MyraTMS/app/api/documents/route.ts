import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"

export async function GET(req: NextRequest) {
  const sql = getDb()
  const relatedTo = req.nextUrl.searchParams.get("relatedTo")
  const relatedType = req.nextUrl.searchParams.get("relatedType")
  const search = req.nextUrl.searchParams.get("search")

  let rows
  if (relatedTo && relatedType) {
    rows = await sql`SELECT * FROM documents WHERE related_to = ${relatedTo} AND related_type = ${relatedType} ORDER BY created_at DESC`
  } else if (search) {
    rows = await sql`SELECT * FROM documents WHERE name ILIKE ${"%" + search + "%"} OR related_to ILIKE ${"%" + search + "%"} ORDER BY created_at DESC`
  } else {
    rows = await sql`SELECT * FROM documents ORDER BY created_at DESC`
  }

  return NextResponse.json(rows)
}
