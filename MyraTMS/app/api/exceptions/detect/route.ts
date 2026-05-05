import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { runExceptionDetection } from "@/lib/exceptions/detector"

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const ctx = requireTenantContext(req)

  try {
    const result = await runExceptionDetection(ctx.tenantId)
    return NextResponse.json(result)
  } catch (err) {
    console.error("[exceptions/detect] Error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
