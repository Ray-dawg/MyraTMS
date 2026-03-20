import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { getCurrentUser } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { executeWorkflows } from "@/lib/workflow-engine"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const { id } = await params
  const sql = getDb()

  // Fetch the load joined with its shipper for contact info
  const rows = await sql`
    SELECT
      l.*,
      s.name AS shipper_name_resolved,
      s.contact AS shipper_contact,
      s.email  AS shipper_email
    FROM loads l
    LEFT JOIN shippers s ON s.id = l.shipper_id
    WHERE l.id = ${id}
    LIMIT 1
  `

  if (rows.length === 0) {
    return apiError("Load not found", 404)
  }

  const load = rows[0]

  // Parse optional body overrides — treat missing/empty body gracefully
  let body: { amount?: number; dueDate?: string; notes?: string } = {}
  try {
    const text = await req.text()
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return apiError("Invalid JSON body", 400)
  }

  // Resolve amount: body > load.revenue > load.shipper_rate > 0
  const amount =
    body.amount !== undefined
      ? body.amount
      : load.revenue !== null && load.revenue !== undefined
      ? Number(load.revenue)
      : load.shipper_rate !== null && load.shipper_rate !== undefined
      ? Number(load.shipper_rate)
      : 0

  // Resolve shipper name: joined shipper table > load.shipper_name column > ""
  const shipperName: string =
    load.shipper_name_resolved || load.shipper_name || ""

  // Date helpers
  const today = new Date()
  const todayStr = today.toISOString().split("T")[0] // YYYY-MM-DD

  const dueDate =
    body.dueDate ??
    (() => {
      const d = new Date(today)
      d.setDate(d.getDate() + 30)
      return d.toISOString().split("T")[0]
    })()

  const invoiceId = `INV-${Date.now().toString(36).toUpperCase()}`

  await sql`
    INSERT INTO invoices (
      id,
      load_id,
      shipper_name,
      amount,
      status,
      issue_date,
      due_date,
      days_outstanding,
      factoring_status
    ) VALUES (
      ${invoiceId},
      ${load.id},
      ${shipperName},
      ${amount},
      ${"Pending"},
      ${todayStr},
      ${dueDate},
      ${0},
      ${"N/A"}
    )
  `

  const created = await sql`
    SELECT * FROM invoices WHERE id = ${invoiceId} LIMIT 1
  `

  // Fire workflow engine for new invoice (non-blocking)
  executeWorkflows("invoice_created", {
    loadId: load.id,
    invoiceId,
    amount,
  }).catch((err) => console.error("[loads/invoice POST] workflow error:", err))

  return NextResponse.json(created[0], { status: 201 })
}
