import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { apiError } from "@/lib/api-error"

export async function GET() {
  try {
    const sql = getDb()
    const rows = await sql`
      SELECT id, provider, enabled, config,
        last_success_at, last_error_at, last_error_msg,
        CASE WHEN api_key IS NOT NULL THEN '****' || RIGHT(api_key, 4) ELSE NULL END as api_key_masked,
        CASE WHEN api_secret IS NOT NULL THEN '****' || RIGHT(api_secret, 4) ELSE NULL END as api_secret_masked,
        created_at, updated_at
      FROM integrations ORDER BY provider
    `
    return NextResponse.json(rows)
  } catch (err) {
    console.error("[integrations GET] error:", err)
    return apiError("Failed to fetch integrations", 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const sql = getDb()

    if (!body.provider) return apiError("Provider is required", 400)

    await sql`
      INSERT INTO integrations (provider, api_key, api_secret, config, enabled)
      VALUES (${body.provider}, ${body.apiKey || null}, ${body.apiSecret || null}, ${JSON.stringify(body.config || {})}, ${body.enabled ?? false})
      ON CONFLICT (provider) DO UPDATE SET
        api_key = COALESCE(NULLIF(${body.apiKey || ""}, ''), integrations.api_key),
        api_secret = COALESCE(NULLIF(${body.apiSecret || ""}, ''), integrations.api_secret),
        config = ${JSON.stringify(body.config || {})},
        enabled = ${body.enabled ?? false},
        updated_at = NOW()
    `

    return NextResponse.json({ success: true, provider: body.provider })
  } catch (err) {
    console.error("[integrations POST] error:", err)
    return apiError("Failed to save integration", 500)
  }
}
