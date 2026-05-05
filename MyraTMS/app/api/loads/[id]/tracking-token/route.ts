import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = getCurrentUser(request)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(request)
  const { id } = await params

  const result = await withTenant(ctx.tenantId, async (client) => {
    const { rows: loads } = await client.query(
      `SELECT id FROM loads WHERE id = $1 LIMIT 1`,
      [id],
    )
    if (loads.length === 0) return { notFound: true as const }

    const { rows: existing } = await client.query(
      `SELECT token FROM tracking_tokens WHERE load_id = $1 LIMIT 1`,
      [id],
    )
    if (existing.length > 0) {
      return { token: existing[0].token as string, created: false as const }
    }

    const token = crypto.randomBytes(32).toString("hex")
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    await client.query(
      `INSERT INTO tracking_tokens (id, load_id, token, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [crypto.randomUUID(), id, token, expiresAt.toISOString()],
    )
    await client.query(
      `UPDATE loads SET tracking_token = $1, updated_at = now() WHERE id = $2`,
      [token, id],
    )
    return { token, created: true as const }
  })

  if ("notFound" in result) return apiError("Load not found", 404)

  const trackingBaseUrl =
    process.env.NEXT_PUBLIC_TRACKING_URL ||
    (process.env.NODE_ENV === "development" ? "http://localhost:3002" : "")
  const trackingUrl = `${trackingBaseUrl}/track/${result.token}`

  return NextResponse.json({ token: result.token, trackingUrl }, { status: result.created ? 201 : 200 })
}
