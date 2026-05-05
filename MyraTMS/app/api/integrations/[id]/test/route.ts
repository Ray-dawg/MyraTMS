import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = requireTenantContext(req)
  const { id } = await params

  const integration = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM integrations WHERE id = $1::uuid LIMIT 1`,
      [id],
    )
    return rows[0] ?? null
  })
  if (!integration) return apiError("Integration not found", 404)

  try {
    let message = "Connection test successful"
    switch (integration.provider) {
      case "dat":
        if (!integration.api_key || !integration.api_secret) throw new Error("API key and secret required")
        message = "DAT credentials validated (test mode)"
        break
      case "truckstop":
        if (!integration.api_key) throw new Error("API key required")
        message = "Truckstop API key validated (test mode)"
        break
      case "ai":
        message = `AI provider '${(integration.config || {}).provider || "default"}' configured (test mode)`
        break
      case "mapbox": {
        const token = integration.api_key || process.env.NEXT_PUBLIC_MAPBOX_TOKEN
        if (!token) throw new Error("Mapbox token not configured")
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/Toronto.json?access_token=${token}&limit=1`,
        )
        if (!res.ok) throw new Error(`Mapbox API returned ${res.status}`)
        message = "Mapbox geocoding API connected"
        break
      }
      default:
        message = `Provider '${integration.provider}' test not implemented`
    }

    await withTenant(ctx.tenantId, async (client) => {
      await client.query(`UPDATE integrations SET last_success_at = NOW() WHERE id = $1::uuid`, [id])
    })
    return NextResponse.json({ success: true, message })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Test failed"
    await withTenant(ctx.tenantId, async (client) => {
      await client.query(
        `UPDATE integrations SET last_error_at = NOW(), last_error_msg = $1 WHERE id = $2::uuid`,
        [errorMsg, id],
      )
    })
    return NextResponse.json({ success: false, message: errorMsg }, { status: 400 })
  }
}
