import { streamText, convertToModelMessages, tool, stepCountIs } from "ai"
import { z } from "zod"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { escapeLikeMeta } from "@/lib/escape-like"
import type { NextRequest } from "next/server"

export async function POST(req: NextRequest) {
  const ctx = requireTenantContext(req)
  const { messages } = await req.json()

  const result = streamText({
    model: "xai/grok-3-mini-fast",
    system: `You are Myra AI, an intelligent assistant built into the Myra TMS (Trucking Management System) for freight brokerage operations.

Your capabilities:
- Answer questions about loads, shippers, carriers, invoices, and documents
- Provide freight brokerage industry insights and best practices
- Help with rate analysis, lane optimization, and carrier selection
- Assist with compliance questions (FMCSA regulations, insurance requirements)
- Generate operational summaries and recommendations

Guidelines:
- Be concise and actionable. Brokers are busy.
- Use industry terminology (lanes, deadhead, dwell time, accessorials, etc.)
- When discussing financials, always consider margin impact
- Flag compliance risks proactively
- Format data in tables when presenting multiple items`,
    messages: await convertToModelMessages(messages),
    tools: {
      lookupLoad: tool({
        description: "Look up a specific load by ID to get its details",
        inputSchema: z.object({ loadId: z.string().describe("The load ID, e.g. LD-001") }),
        execute: async ({ loadId }) =>
          withTenant(ctx.tenantId, async (client) => {
            const { rows } = await client.query(
              `SELECT * FROM loads WHERE id = $1 LIMIT 1`,
              [loadId],
            )
            if (rows.length === 0) return { error: "Load not found" }
            return rows[0]
          }),
      }),
      searchLoads: tool({
        description: "Search loads by status, origin, destination, or shipper",
        inputSchema: z.object({
          status: z.string().nullable().describe("Filter by status"),
          search: z.string().nullable().describe("Search term for origin/destination/shipper"),
        }),
        execute: async ({ status, search }) =>
          withTenant(ctx.tenantId, async (client) => {
            let rows
            if (status && search) {
              const like = `%${escapeLikeMeta(search)}%`
              ;({ rows } = await client.query(
                `SELECT id, origin, destination, shipper_name, status, revenue, margin
                   FROM loads
                  WHERE status = $1 AND (origin ILIKE $2 OR destination ILIKE $2)
                  LIMIT 10`,
                [status, like],
              ))
            } else if (status) {
              ;({ rows } = await client.query(
                `SELECT id, origin, destination, shipper_name, status, revenue, margin
                   FROM loads WHERE status = $1 LIMIT 10`,
                [status],
              ))
            } else if (search) {
              const like = `%${escapeLikeMeta(search)}%`
              ;({ rows } = await client.query(
                `SELECT id, origin, destination, shipper_name, status, revenue, margin
                   FROM loads
                  WHERE origin ILIKE $1 OR destination ILIKE $1 OR shipper_name ILIKE $1
                  LIMIT 10`,
                [like],
              ))
            } else {
              ;({ rows } = await client.query(
                `SELECT id, origin, destination, shipper_name, status, revenue, margin
                   FROM loads ORDER BY created_at DESC LIMIT 10`,
              ))
            }
            return { count: rows.length, loads: rows }
          }),
      }),
      getFinanceSummary: tool({
        description: "Get financial overview including revenue, margin, and invoice status",
        inputSchema: z.object({}),
        execute: async () =>
          withTenant(ctx.tenantId, async (client) => {
            const { rows: revRows } = await client.query(
              `SELECT COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(margin),0) as margin FROM loads`,
            )
            const { rows: invRows } = await client.query(
              `SELECT
                 COALESCE(SUM(CASE WHEN status='Overdue' THEN amount ELSE 0 END),0) as overdue,
                 COALESCE(SUM(CASE WHEN status='Pending' THEN amount ELSE 0 END),0) as pending
                 FROM invoices`,
            )
            return {
              totalRevenue: Number(revRows[0].revenue),
              totalMargin: Number(revRows[0].margin),
              overdueInvoices: Number(invRows[0].overdue),
              pendingInvoices: Number(invRows[0].pending),
            }
          }),
      }),
      lookupCarrier: tool({
        description: "Look up carrier details and compliance status",
        inputSchema: z.object({ carrierId: z.string().describe("Carrier ID, e.g. CAR-001") }),
        execute: async ({ carrierId }) =>
          withTenant(ctx.tenantId, async (client) => {
            const { rows } = await client.query(
              `SELECT * FROM carriers WHERE id = $1 LIMIT 1`,
              [carrierId],
            )
            if (rows.length === 0) return { error: "Carrier not found" }
            return rows[0]
          }),
      }),
    },
    stopWhen: stepCountIs(5),
  })

  return result.toUIMessageStreamResponse()
}
