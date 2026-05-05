import { generateText, Output } from "ai"
import { z } from "zod"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import type { NextRequest } from "next/server"

export async function POST(req: NextRequest) {
  const ctx = requireTenantContext(req)

  const { loads, alerts, carriers } = await withTenant(ctx.tenantId, async (client) => {
    const [loads, alerts, carriers] = await Promise.all([
      client.query(
        `SELECT id, origin, destination, shipper_name, carrier_name, status, margin_percent, risk_flag
           FROM loads WHERE status IN ('Booked','Dispatched','In Transit') LIMIT 20`,
      ),
      client.query(
        `SELECT * FROM compliance_alerts WHERE resolved = false ORDER BY detected_at DESC LIMIT 10`,
      ),
      client.query(
        `SELECT id, company, authority_status, insurance_status, safety_rating, on_time_percent
           FROM carriers
          WHERE risk_flag = true OR authority_status != 'Active' OR insurance_status != 'Active'`,
      ),
    ])
    return { loads: loads.rows, alerts: alerts.rows, carriers: carriers.rows }
  })

  const { output } = await generateText({
    model: "xai/grok-3-mini-fast",
    output: Output.object({
      schema: z.object({
        riskAlerts: z.array(z.object({
          severity: z.enum(["critical", "high", "medium", "low"]),
          title: z.string(),
          description: z.string(),
          recommendation: z.string(),
          affectedEntity: z.string().nullable(),
        })),
        overallRiskScore: z.number().min(0).max(100),
        summary: z.string(),
      }),
    }),
    prompt: `Analyze these active freight brokerage operations for risk.

Active loads: ${JSON.stringify(loads)}
Unresolved compliance alerts: ${JSON.stringify(alerts)}
Flagged carriers: ${JSON.stringify(carriers)}

Identify risks related to:
1. Low-margin or negative-margin loads
2. Carrier compliance issues (authority, insurance, safety)
3. Operational bottlenecks (too many loads in one status)
4. Any patterns that could lead to financial or compliance problems

Provide an overall risk score (0=no risk, 100=critical) and actionable recommendations.`,
  })

  return Response.json(output)
}
