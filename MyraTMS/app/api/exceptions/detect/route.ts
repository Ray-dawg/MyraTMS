import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/auth"
import { runExceptionDetection } from "@/lib/exceptions/detector"

// ---------------------------------------------------------------------------
// POST /api/exceptions/detect
//
// Manual trigger — lets admins run exception detection on demand.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const result = await runExceptionDetection()
    return NextResponse.json(result)
  } catch (err) {
    console.error("[exceptions/detect] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
