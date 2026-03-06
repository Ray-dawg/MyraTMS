import { NextResponse } from "next/server"
import { getDb } from "@/lib/db"

export async function GET() {
  const sql = getDb()

  const [revenueResult] = await sql`SELECT COALESCE(SUM(revenue), 0) as total_revenue, COALESCE(SUM(margin), 0) as total_margin FROM loads`
  const [invoiceResult] = await sql`SELECT COALESCE(SUM(CASE WHEN status = 'Paid' THEN amount ELSE 0 END), 0) as collected, COALESCE(SUM(CASE WHEN status != 'Paid' THEN amount ELSE 0 END), 0) as outstanding, COALESCE(SUM(CASE WHEN status = 'Overdue' THEN amount ELSE 0 END), 0) as overdue FROM invoices`
  const [loadCounts] = await sql`SELECT COUNT(*) as total, COUNT(CASE WHEN status = 'In Transit' THEN 1 END) as in_transit, COUNT(CASE WHEN status = 'Delivered' THEN 1 END) as delivered FROM loads`

  return NextResponse.json({
    totalRevenue: Number(revenueResult.total_revenue),
    totalMargin: Number(revenueResult.total_margin),
    collected: Number(invoiceResult.collected),
    outstanding: Number(invoiceResult.outstanding),
    overdue: Number(invoiceResult.overdue),
    totalLoads: Number(loadCounts.total),
    inTransit: Number(loadCounts.in_transit),
    delivered: Number(loadCounts.delivered),
  })
}
