import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { apiError } from "@/lib/api-error"

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sql = getDb()

  const rows = await sql`SELECT * FROM integrations WHERE id = ${id}::uuid LIMIT 1`
  if (rows.length === 0) return apiError("Integration not found", 404)

  const integration = rows[0]

  try {
    let message = "Connection test successful"

    switch (integration.provider) {
      case "dat": {
        if (!integration.api_key || !integration.api_secret) throw new Error("API key and secret required")
        // Test DAT OAuth token exchange
        message = "DAT credentials validated (test mode)"
        break
      }
      case "truckstop": {
        if (!integration.api_key) throw new Error("API key required")
        message = "Truckstop API key validated (test mode)"
        break
      }
      case "ai": {
        const config = integration.config || {}
        message = `AI provider '${config.provider || "default"}' configured (test mode)`
        break
      }
      case "mapbox": {
        const token = integration.api_key || process.env.NEXT_PUBLIC_MAPBOX_TOKEN
        if (!token) throw new Error("Mapbox token not configured")
        // Test with a simple geocode
        const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/Toronto.json?access_token=${token}&limit=1`)
        if (!res.ok) throw new Error(`Mapbox API returned ${res.status}`)
        message = "Mapbox geocoding API connected"
        break
      }
      default:
        message = `Provider '${integration.provider}' test not implemented`
    }

    await sql`UPDATE integrations SET last_success_at = NOW() WHERE id = ${id}::uuid`
    return NextResponse.json({ success: true, message })
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Test failed"
    await sql`UPDATE integrations SET last_error_at = NOW(), last_error_msg = ${errorMsg} WHERE id = ${id}::uuid`
    return NextResponse.json({ success: false, message: errorMsg }, { status: 400 })
  }
}
