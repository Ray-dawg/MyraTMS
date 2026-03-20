import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/auth"
import { getDb } from "@/lib/db"

// ---------------------------------------------------------------------------
// GET /api/exceptions
//
// Returns exceptions with optional filters + severity counts.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const sql = getDb()
  const params = req.nextUrl.searchParams
  const status = params.get("status") || "active"
  const severity = params.get("severity")
  const limit = Math.min(Number(params.get("limit") || 50), 200)

  try {
    // Query with all possible filter combinations (avoids dynamic SQL)
    const exceptions =
      status !== "all" && severity
        ? await sql`
            SELECT e.*,
                   l.reference_number, l.origin_city, l.dest_city,
                   c.company AS carrier_name
            FROM exceptions e
            LEFT JOIN loads l ON e.load_id = l.id
            LEFT JOIN carriers c ON e.carrier_id = c.id
            WHERE e.status = ${status} AND e.severity = ${severity}
            ORDER BY
              CASE e.severity
                WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                WHEN 'medium' THEN 2 WHEN 'low' THEN 3
              END,
              e.created_at DESC
            LIMIT ${limit}
          `
        : status !== "all"
          ? await sql`
              SELECT e.*,
                     l.reference_number, l.origin_city, l.dest_city,
                     c.company AS carrier_name
              FROM exceptions e
              LEFT JOIN loads l ON e.load_id = l.id
              LEFT JOIN carriers c ON e.carrier_id = c.id
              WHERE e.status = ${status}
              ORDER BY
                CASE e.severity
                  WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                  WHEN 'medium' THEN 2 WHEN 'low' THEN 3
                END,
                e.created_at DESC
              LIMIT ${limit}
            `
          : severity
            ? await sql`
                SELECT e.*,
                       l.reference_number, l.origin_city, l.dest_city,
                       c.company AS carrier_name
                FROM exceptions e
                LEFT JOIN loads l ON e.load_id = l.id
                LEFT JOIN carriers c ON e.carrier_id = c.id
                WHERE e.severity = ${severity}
                ORDER BY
                  CASE e.severity
                    WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                    WHEN 'medium' THEN 2 WHEN 'low' THEN 3
                  END,
                  e.created_at DESC
                LIMIT ${limit}
              `
            : await sql`
                SELECT e.*,
                       l.reference_number, l.origin_city, l.dest_city,
                       c.company AS carrier_name
                FROM exceptions e
                LEFT JOIN loads l ON e.load_id = l.id
                LEFT JOIN carriers c ON e.carrier_id = c.id
                ORDER BY
                  CASE e.severity
                    WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                    WHEN 'medium' THEN 2 WHEN 'low' THEN 3
                  END,
                  e.created_at DESC
                LIMIT ${limit}
              `

    // Counts of active exceptions by severity
    const counts = await sql`
      SELECT
        COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
        COUNT(*) FILTER (WHERE severity = 'high') AS high,
        COUNT(*) FILTER (WHERE severity = 'medium') AS medium,
        COUNT(*) FILTER (WHERE severity = 'low') AS low,
        COUNT(*) AS total
      FROM exceptions
      WHERE status = 'active'
    `

    return NextResponse.json({
      exceptions,
      counts: {
        critical: Number(counts[0].critical),
        high: Number(counts[0].high),
        medium: Number(counts[0].medium),
        low: Number(counts[0].low),
        total: Number(counts[0].total),
      },
    })
  } catch (err) {
    console.error("[GET /api/exceptions] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
