import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { apiError } from "@/lib/api-error"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { rows } = body

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return apiError("rows array is required", 400)
    }

    const sql = getDb()
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    let inserted = 0
    const errors: string[] = []

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (!row.origin_region || !row.dest_region || !row.equipment_type || !row.rate_per_mile) {
        errors.push(`Row ${i + 1}: missing required fields`)
        continue
      }
      try {
        await sql`
          INSERT INTO rate_cache (origin_region, dest_region, equipment_type, rate_per_mile, total_rate, source, expires_at)
          VALUES (${row.origin_region}, ${row.dest_region}, ${row.equipment_type}, ${Number(row.rate_per_mile)}, ${row.total_rate ? Number(row.total_rate) : null}, 'manual', ${expiresAt})
        `
        inserted++
      } catch (err) {
        errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : "insert failed"}`)
      }
    }

    return NextResponse.json({ inserted, errors, total: rows.length })
  } catch (err) {
    console.error("[rates import] error:", err)
    return apiError("Failed to import rates", 500)
  }
}
