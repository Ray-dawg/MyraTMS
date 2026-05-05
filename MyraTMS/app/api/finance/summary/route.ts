import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"

export async function GET(req: NextRequest) {
  const ctx = requireTenantContext(req)

  const data = await withTenant(ctx.tenantId, async (client) => {
    const { rows: revenueRows } = await client.query(
      `SELECT COALESCE(SUM(revenue), 0) as total_revenue,
              COALESCE(SUM(margin), 0) as total_margin
         FROM loads`,
    )
    const { rows: invoiceRows } = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'Paid' THEN amount ELSE 0 END), 0) as collected,
         COALESCE(SUM(CASE WHEN status != 'Paid' THEN amount ELSE 0 END), 0) as outstanding,
         COALESCE(SUM(CASE WHEN status = 'Overdue' THEN amount ELSE 0 END), 0) as overdue
         FROM invoices`,
    )
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*) as total,
              COUNT(CASE WHEN status = 'In Transit' THEN 1 END) as in_transit,
              COUNT(CASE WHEN status = 'Delivered' THEN 1 END) as delivered
         FROM loads`,
    )
    return {
      revenue: revenueRows[0],
      invoice: invoiceRows[0],
      count: countRows[0],
    }
  })

  return NextResponse.json({
    totalRevenue: Number(data.revenue.total_revenue),
    totalMargin: Number(data.revenue.total_margin),
    collected: Number(data.invoice.collected),
    outstanding: Number(data.invoice.outstanding),
    overdue: Number(data.invoice.overdue),
    totalLoads: Number(data.count.total),
    inTransit: Number(data.count.in_transit),
    delivered: Number(data.count.delivered),
  })
}
