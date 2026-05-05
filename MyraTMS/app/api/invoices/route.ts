import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { executeWorkflows } from "@/lib/workflow-engine"

export async function GET(req: NextRequest) {
  const ctx = requireTenantContext(req)
  const status = req.nextUrl.searchParams.get("status")
  const loadId = req.nextUrl.searchParams.get("loadId")

  const rows = await withTenant(ctx.tenantId, async (client) => {
    if (loadId) {
      const { rows } = await client.query(
        `SELECT * FROM invoices WHERE load_id = $1 ORDER BY created_at DESC`,
        [loadId],
      )
      return rows
    }
    if (status) {
      const { rows } = await client.query(
        `SELECT * FROM invoices WHERE status = $1 ORDER BY created_at DESC`,
        [status],
      )
      return rows
    }
    const { rows } = await client.query(
      `SELECT * FROM invoices ORDER BY created_at DESC`,
    )
    return rows
  })

  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const ctx = requireTenantContext(req)
  const body = await req.json()
  const id = `INV-${Date.now().toString(36).toUpperCase()}`

  await withTenant(ctx.tenantId, async (client) => {
    await client.query(
      `INSERT INTO invoices (
         id, load_id, shipper_name, amount, status, issue_date, due_date,
         factoring_status, days_outstanding
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9
       )`,
      [
        id,
        body.loadId,
        body.shipperName || "",
        body.amount || 0,
        body.status || "Pending",
        body.issueDate || null,
        body.dueDate || null,
        body.factoringStatus || "N/A",
        body.daysOutstanding || 0,
      ],
    )
  })

  // Fire workflow engine for new invoice (non-blocking)
  executeWorkflows(ctx.tenantId, "invoice_created", {
    loadId: body.loadId,
    invoiceId: id,
    amount: body.amount || 0,
  }).catch((err) => console.error("[invoices POST] workflow error:", err))

  return NextResponse.json({ id }, { status: 201 })
}
