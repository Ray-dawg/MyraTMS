import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { executeWorkflows } from "@/lib/workflow-engine"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)
  const { id } = await params

  let body: { amount?: number; dueDate?: string; notes?: string } = {}
  try {
    const text = await req.text()
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return apiError("Invalid JSON body", 400)
  }

  const result = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT
         l.*,
         s.name AS shipper_name_resolved,
         s.contact AS shipper_contact,
         s.email  AS shipper_email
         FROM loads l
         LEFT JOIN shippers s ON s.id = l.shipper_id
        WHERE l.id = $1
        LIMIT 1`,
      [id],
    )
    if (rows.length === 0) return { notFound: true as const }
    const load = rows[0]

    const amount =
      body.amount !== undefined
        ? body.amount
        : load.revenue !== null && load.revenue !== undefined
          ? Number(load.revenue)
          : load.shipper_rate !== null && load.shipper_rate !== undefined
            ? Number(load.shipper_rate)
            : 0

    const shipperName: string = load.shipper_name_resolved || load.shipper_name || ""

    const today = new Date()
    const todayStr = today.toISOString().split("T")[0]
    const dueDate =
      body.dueDate ??
      (() => {
        const d = new Date(today)
        d.setDate(d.getDate() + 30)
        return d.toISOString().split("T")[0]
      })()

    const invoiceId = `INV-${Date.now().toString(36).toUpperCase()}`

    await client.query(
      `INSERT INTO invoices (
         id, load_id, shipper_name, amount, status, issue_date, due_date,
         days_outstanding, factoring_status
       ) VALUES (
         $1, $2, $3, $4, 'Pending', $5, $6, 0, 'N/A'
       )`,
      [invoiceId, load.id, shipperName, amount, todayStr, dueDate],
    )

    const { rows: created } = await client.query(
      `SELECT * FROM invoices WHERE id = $1 LIMIT 1`,
      [invoiceId],
    )
    return { row: created[0], invoiceId, loadId: load.id, amount }
  })

  if ("notFound" in result) return apiError("Load not found", 404)

  executeWorkflows(ctx.tenantId, "invoice_created", {
    loadId: result.loadId,
    invoiceId: result.invoiceId,
    amount: result.amount,
  }).catch((err) => console.error("[loads/invoice POST] workflow error:", err))

  return NextResponse.json(result.row, { status: 201 })
}
