import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

// ---------------------------------------------------------------------------
// GET  /api/compliance/alerts — List compliance alerts from DB
//   ?carrier_id=CR-001  — filter by carrier
//   ?severity=critical   — filter by severity (critical, warning, info)
//   ?resolved=false      — filter by resolved status (default: false)
//
// POST /api/compliance/alerts — Create a new compliance alert
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const sql = getDb()
  const { searchParams } = req.nextUrl
  const carrierId = searchParams.get("carrier_id")
  const severity = searchParams.get("severity")
  const resolvedParam = searchParams.get("resolved")

  // Default to unresolved alerts
  const showResolved = resolvedParam === "true"

  let rows
  if (carrierId && severity) {
    rows = await sql`
      SELECT ca.*, c.company as carrier_name, c.mc_number
      FROM compliance_alerts ca
      LEFT JOIN carriers c ON c.id = ca.carrier_id
      WHERE ca.carrier_id = ${carrierId}
        AND ca.severity = ${severity}
        AND ca.resolved = ${showResolved}
      ORDER BY ca.detected_at DESC
    `
  } else if (carrierId) {
    rows = await sql`
      SELECT ca.*, c.company as carrier_name, c.mc_number
      FROM compliance_alerts ca
      LEFT JOIN carriers c ON c.id = ca.carrier_id
      WHERE ca.carrier_id = ${carrierId}
        AND ca.resolved = ${showResolved}
      ORDER BY ca.detected_at DESC
    `
  } else if (severity) {
    rows = await sql`
      SELECT ca.*, c.company as carrier_name, c.mc_number
      FROM compliance_alerts ca
      LEFT JOIN carriers c ON c.id = ca.carrier_id
      WHERE ca.severity = ${severity}
        AND ca.resolved = ${showResolved}
      ORDER BY ca.detected_at DESC
    `
  } else {
    rows = await sql`
      SELECT ca.*, c.company as carrier_name, c.mc_number
      FROM compliance_alerts ca
      LEFT JOIN carriers c ON c.id = ca.carrier_id
      WHERE ca.resolved = ${showResolved}
      ORDER BY
        CASE ca.severity
          WHEN 'critical' THEN 1
          WHEN 'warning' THEN 2
          WHEN 'info' THEN 3
          ELSE 4
        END,
        ca.detected_at DESC
    `
  }

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

  let body: {
    carrier_id: string
    type: string
    severity: string
    title: string
    description: string
  }
  try {
    body = await req.json()
  } catch {
    return apiError("Invalid JSON body")
  }

  const { carrier_id, type, severity, title, description } = body
  if (!carrier_id || !type || !severity || !title || !description) {
    return apiError("Missing required fields: carrier_id, type, severity, title, description")
  }

  const sql = getDb()
  const id = `CMP-${Date.now().toString(36).toUpperCase()}`

  await sql`
    INSERT INTO compliance_alerts (id, carrier_id, type, severity, title, description, detected_at, resolved)
    VALUES (${id}, ${carrier_id}, ${type}, ${severity}, ${title}, ${description}, NOW(), false)
  `

  return NextResponse.json({ id, carrier_id, type, severity, title, description }, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  let body: { id: string; resolved?: boolean }
  try {
    body = await req.json()
  } catch {
    return apiError("Invalid JSON body")
  }

  if (!body.id) return apiError("Missing alert id")

  const sql = getDb()

  if (body.resolved !== undefined) {
    await sql`
      UPDATE compliance_alerts
      SET resolved = ${body.resolved}, resolved_at = ${body.resolved ? new Date().toISOString() : null}
      WHERE id = ${body.id}
    `
  }

  return NextResponse.json({ success: true, id: body.id })
}
