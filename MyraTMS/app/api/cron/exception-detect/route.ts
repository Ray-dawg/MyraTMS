import { NextRequest, NextResponse } from "next/server"
import { runExceptionDetection } from "@/lib/exceptions/detector"
import { forEachActiveTenant } from "@/lib/db/tenant-context"

// ---------------------------------------------------------------------------
// GET /api/cron/exception-detect
//
// Vercel Cron (every 5 min). Iterates every active tenant and runs the
// exception detector inside that tenant's RLS scope. Per-tenant failures
// are logged but do not abort the run.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const summary = await forEachActiveTenant(
      "cron:exception-detect",
      async ({ tenantId }) => runExceptionDetection(tenantId),
    )
    const totals = summary.results.reduce(
      (acc, r) => {
        if (r.ok && r.result) {
          acc.created += r.result.created
          acc.resolved += r.result.resolved
        }
        return acc
      },
      { created: 0, resolved: 0 },
    )
    console.log(
      `[cron/exception-detect] tenants=${summary.totalTenants} ok=${summary.succeeded} failed=${summary.failed} created=${totals.created} resolved=${totals.resolved} duration=${summary.durationMs}ms`,
    )
    return NextResponse.json({ ...summary, totals })
  } catch (err) {
    console.error("[cron/exception-detect] Fatal error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
