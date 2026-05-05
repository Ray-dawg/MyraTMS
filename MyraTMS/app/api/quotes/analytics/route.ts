import { NextRequest, NextResponse } from "next/server"
import { requireTenantContext } from "@/lib/auth"
import { getQuoteAnalytics } from "@/lib/quoting/feedback"
import { apiError } from "@/lib/api-error"

export async function GET(req: NextRequest) {
  try {
    const ctx = requireTenantContext(req)
    const analytics = await getQuoteAnalytics(ctx.tenantId)
    return NextResponse.json(analytics)
  } catch (err) {
    console.error("[quotes analytics] error:", err)
    return apiError("Failed to fetch analytics", 500)
  }
}
