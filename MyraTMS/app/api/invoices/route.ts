import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { executeWorkflows } from "@/lib/workflow-engine"

export async function GET(req: NextRequest) {
  const sql = getDb()
  const status = req.nextUrl.searchParams.get("status")
  const loadId = req.nextUrl.searchParams.get("loadId")

  let rows
  if (loadId) {
    rows = await sql`SELECT * FROM invoices WHERE load_id = ${loadId} ORDER BY created_at DESC`
  } else if (status) {
    rows = await sql`SELECT * FROM invoices WHERE status = ${status} ORDER BY created_at DESC`
  } else {
    rows = await sql`SELECT * FROM invoices ORDER BY created_at DESC`
  }

  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const sql = getDb()
  const id = `INV-${Date.now().toString(36).toUpperCase()}`

  await sql`
    INSERT INTO invoices (id, load_id, shipper_name, amount, status, issue_date, due_date, factoring_status, days_outstanding)
    VALUES (${id}, ${body.loadId}, ${body.shipperName || ""}, ${body.amount || 0}, ${body.status || "Pending"}, ${body.issueDate || null}, ${body.dueDate || null}, ${body.factoringStatus || "N/A"}, ${body.daysOutstanding || 0})
  `

  // Fire workflow engine for new invoice (non-blocking)
  executeWorkflows("invoice_created", {
    loadId: body.loadId,
    invoiceId: id,
    amount: body.amount || 0,
  }).catch((err) => console.error("[invoices POST] workflow error:", err))

  return NextResponse.json({ id }, { status: 201 })
}
