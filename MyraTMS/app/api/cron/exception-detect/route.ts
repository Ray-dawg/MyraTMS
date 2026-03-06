import { NextRequest, NextResponse } from "next/server"
import { runExceptionDetection } from "@/lib/exceptions/detector"

// ---------------------------------------------------------------------------
// GET /api/cron/exception-detect
//
// Vercel Cron job (every 5 minutes) that runs the exception detection engine.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const result = await runExceptionDetection()
    console.log(`[cron/exception-detect] Done: created=${result.created} resolved=${result.resolved}`)
    return NextResponse.json(result)
  } catch (err) {
    console.error("[cron/exception-detect] Fatal error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
