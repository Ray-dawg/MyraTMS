import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { withTenant } from "@/lib/db/tenant-context"
import { verifyRatingToken } from "@/lib/rating-token"
import { createNotification } from "@/lib/notifications"

/**
 * Public delivery-rating submission endpoint. Token IS the auth.
 *
 * Tenant resolution: rating tokens are independent of tracking_tokens, so we
 * resolve the load_id from the rating-token payload, then look it up via the
 * service-admin path (loads.tenant_id) to find the owning tenant.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  try {
    const body = await req.json()
    const rating = Number(body.rating)
    const comment = typeof body.comment === "string" ? body.comment.slice(0, 500) : ""

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return NextResponse.json(
        { error: "Rating must be an integer between 1 and 5" },
        { status: 400 },
      )
    }

    const payload = verifyRatingToken(token)
    if (!payload) {
      return NextResponse.json({ error: "Invalid or expired rating link" }, { status: 401 })
    }

    const { loadId, shipperId } = payload

    // Resolve the tenant for this load via service-admin (cross-tenant lookup)
    const { asServiceAdmin } = await import("@/lib/db/tenant-context")
    const tenantId = await asServiceAdmin(
      "rate-token-tenant-lookup: resolving tenant for public delivery-rating submission",
      async (client) => {
        const { rows } = await client.query<{ tenant_id: number }>(
          `SELECT tenant_id FROM loads WHERE id = $1 LIMIT 1`,
          [loadId],
        )
        return rows[0]?.tenant_id ?? null
      },
    )
    if (!tenantId) {
      return NextResponse.json({ error: "Invalid or expired rating link" }, { status: 404 })
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex")

    const result = await withTenant(tenantId, async (client) => {
      const { rows: existing } = await client.query(
        `SELECT id FROM delivery_ratings WHERE token_hash = $1 LIMIT 1`,
        [tokenHash],
      )
      if (existing.length > 0) return { duplicate: true as const }

      const ratingId = `RTG-${Date.now().toString(36).toUpperCase()}`
      await client.query(
        `INSERT INTO delivery_ratings (id, load_id, shipper_id, rating, comment, token_hash)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ratingId, loadId, shipperId, rating, comment, tokenHash],
      )

      const { rows: loads } = await client.query(
        `SELECT reference_number FROM loads WHERE id = $1 LIMIT 1`,
        [loadId],
      )
      return { loadRef: loads[0]?.reference_number || loadId }
    })

    if ("duplicate" in result) {
      return NextResponse.json(
        { error: "You have already submitted a rating for this delivery" },
        { status: 409 },
      )
    }

    await createNotification({
      tenantId,
      type: "info",
      title: `Shipper rated delivery ${rating}/5 — Load ${result.loadRef}`,
      body: comment || `Rating: ${rating}/5`,
      link: `/loads/${loadId}`,
      loadId,
      userId: null,
    })

    return NextResponse.json({ success: true, rating })
  } catch (error) {
    console.error("[api/rate] Error:", error)
    return NextResponse.json({ error: "Failed to submit rating" }, { status: 500 })
  }
}
