import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)

  const { searchParams } = req.nextUrl
  const carrierId = searchParams.get("carrier_id")
  const severity = searchParams.get("severity")
  const showResolved = searchParams.get("resolved") === "true"

  const baseSelect = `SELECT ca.*, c.company as carrier_name, c.mc_number
                        FROM compliance_alerts ca
                        LEFT JOIN carriers c ON c.id = ca.carrier_id`

  const rows = await withTenant(ctx.tenantId, async (client) => {
    if (carrierId && severity) {
      const { rows } = await client.query(
        `${baseSelect}
          WHERE ca.carrier_id = $1 AND ca.severity = $2 AND ca.resolved = $3
          ORDER BY ca.detected_at DESC`,
        [carrierId, severity, showResolved],
      )
      return rows
    }
    if (carrierId) {
      const { rows } = await client.query(
        `${baseSelect}
          WHERE ca.carrier_id = $1 AND ca.resolved = $2
          ORDER BY ca.detected_at DESC`,
        [carrierId, showResolved],
      )
      return rows
    }
    if (severity) {
      const { rows } = await client.query(
        `${baseSelect}
          WHERE ca.severity = $1 AND ca.resolved = $2
          ORDER BY ca.detected_at DESC`,
        [severity, showResolved],
      )
      return rows
    }
    const { rows } = await client.query(
      `${baseSelect}
        WHERE ca.resolved = $1
        ORDER BY
          CASE ca.severity
            WHEN 'critical' THEN 1
            WHEN 'warning' THEN 2
            WHEN 'info' THEN 3
            ELSE 4
          END,
          ca.detected_at DESC`,
      [showResolved],
    )
    return rows
  })

  const critical = rows.filter((a) => a.severity === "critical").length
  const warnings = rows.filter((a) => a.severity === "warning").length
  const info = rows.filter((a) => a.severity === "info").length

  return NextResponse.json({
    alerts: rows,
    summary: { total: rows.length, critical, warnings, info },
  })
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)

  let body: { carrier_id: string; type: string; severity: string; title: string; description: string }
  try {
    body = await req.json()
  } catch {
    return apiError("Invalid JSON body")
  }

  const { carrier_id, type, severity, title, description } = body
  if (!carrier_id || !type || !severity || !title || !description) {
    return apiError("Missing required fields: carrier_id, type, severity, title, description")
  }

  const id = `CMP-${Date.now().toString(36).toUpperCase()}`
  await withTenant(ctx.tenantId, async (client) => {
    await client.query(
      `INSERT INTO compliance_alerts (id, carrier_id, type, severity, title, description, detected_at, resolved)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), false)`,
      [id, carrier_id, type, severity, title, description],
    )
  })

  return NextResponse.json({ id, carrier_id, type, severity, title, description }, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)

  let body: { id: string; resolved?: boolean }
  try {
    body = await req.json()
  } catch {
    return apiError("Invalid JSON body")
  }

  if (!body.id) return apiError("Missing alert id")

  if (body.resolved !== undefined) {
    await withTenant(ctx.tenantId, async (client) => {
      await client.query(
        `UPDATE compliance_alerts
            SET resolved = $1, resolved_at = $2
          WHERE id = $3`,
        [body.resolved, body.resolved ? new Date().toISOString() : null, body.id],
      )
    })
  }

  return NextResponse.json({ success: true, id: body.id })
}
