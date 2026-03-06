import { NextResponse } from "next/server"
import { getQuoteAnalytics } from "@/lib/quoting/feedback"
import { apiError } from "@/lib/api-error"

export async function GET() {
  try {
    const analytics = await getQuoteAnalytics()
    return NextResponse.json(analytics)
  } catch (err) {
    console.error("[quotes analytics] error:", err)
    return apiError("Failed to fetch analytics", 500)
  }
}
