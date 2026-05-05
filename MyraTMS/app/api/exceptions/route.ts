import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const ctx = requireTenantContext(req)

  const params = req.nextUrl.searchParams
  const status = params.get("status") || "active"
  const severity = params.get("severity")
  const limit = Math.min(Number(params.get("limit") || 50), 200)

  try {
    const data = await withTenant(ctx.tenantId, async (client) => {
      const orderClause = `ORDER BY
        CASE e.severity
          WHEN 'critical' THEN 0 WHEN 'high' THEN 1
          WHEN 'medium' THEN 2 WHEN 'low' THEN 3
        END,
        e.created_at DESC`
      const baseSelect = `SELECT e.*, l.reference_number, l.origin_city, l.dest_city, c.company AS carrier_name
                            FROM exceptions e
                            LEFT JOIN loads l ON e.load_id = l.id
                            LEFT JOIN carriers c ON e.carrier_id = c.id`

      let exceptions
      if (status !== "all" && severity) {
        exceptions = (await client.query(
          `${baseSelect} WHERE e.status = $1 AND e.severity = $2 ${orderClause} LIMIT $3`,
          [status, severity, limit],
        )).rows
      } else if (status !== "all") {
        exceptions = (await client.query(
          `${baseSelect} WHERE e.status = $1 ${orderClause} LIMIT $2`,
          [status, limit],
        )).rows
      } else if (severity) {
        exceptions = (await client.query(
          `${baseSelect} WHERE e.severity = $1 ${orderClause} LIMIT $2`,
          [severity, limit],
        )).rows
      } else {
        exceptions = (await client.query(
          `${baseSelect} ${orderClause} LIMIT $1`,
          [limit],
        )).rows
      }

      const { rows: counts } = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
           COUNT(*) FILTER (WHERE severity = 'high') AS high,
           COUNT(*) FILTER (WHERE severity = 'medium') AS medium,
           COUNT(*) FILTER (WHERE severity = 'low') AS low,
           COUNT(*) AS total
           FROM exceptions
          WHERE status = 'active'`,
      )

      return {
        exceptions,
        counts: {
          critical: Number(counts[0].critical),
          high: Number(counts[0].high),
          medium: Number(counts[0].medium),
          low: Number(counts[0].low),
          total: Number(counts[0].total),
        },
      }
    })

    return NextResponse.json(data)
  } catch (err) {
    console.error("[GET /api/exceptions] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
