import { NextRequest, NextResponse } from "next/server"
import { del } from "@vercel/blob"
import { getDb } from "@/lib/db"

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sql = getDb()

  const rows = await sql`SELECT blob_url FROM documents WHERE id = ${id} LIMIT 1`
  if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 })

  if (rows[0].blob_url) {
    try {
      await del(rows[0].blob_url)
    } catch {
      // Blob may not exist, continue with DB deletion
    }
  }

  await sql`DELETE FROM documents WHERE id = ${id}`

  return NextResponse.json({ success: true })
}
