import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function GET(req: NextRequest) {
  try {
    const ctx = requireTenantContext(req)
    const rows = await withTenant(ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, provider, enabled, config,
                last_success_at, last_error_at, last_error_msg,
                CASE WHEN api_key IS NOT NULL THEN '****' || RIGHT(api_key, 4) ELSE NULL END as api_key_masked,
                CASE WHEN api_secret IS NOT NULL THEN '****' || RIGHT(api_secret, 4) ELSE NULL END as api_secret_masked,
                created_at, updated_at
           FROM integrations ORDER BY provider`,
      )
      return rows
    })
    return NextResponse.json(rows)
  } catch (err) {
    console.error("[integrations GET] error:", err)
    return apiError("Failed to fetch integrations", 500)
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = requireTenantContext(req)
    const body = await req.json()
    if (!body.provider) return apiError("Provider is required", 400)

    await withTenant(ctx.tenantId, async (client) => {
      await client.query(
        `INSERT INTO integrations (provider, api_key, api_secret, config, enabled)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (provider) DO UPDATE SET
           api_key = COALESCE(NULLIF($2, ''), integrations.api_key),
           api_secret = COALESCE(NULLIF($3, ''), integrations.api_secret),
           config = $4,
           enabled = $5,
           updated_at = NOW()`,
        [
          body.provider,
          body.apiKey || null,
          body.apiSecret || null,
          JSON.stringify(body.config || {}),
          body.enabled ?? false,
        ],
      )
    })

    return NextResponse.json({ success: true, provider: body.provider })
  } catch (err) {
    console.error("[integrations POST] error:", err)
    return apiError("Failed to save integration", 500)
  }
}
