import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { verifyRatingToken } from "@/lib/rating-token"
import { createNotification } from "@/lib/notifications"
import crypto from "crypto"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  try {
    const body = await req.json()
    const rating = Number(body.rating)
    const comment = typeof body.comment === "string" ? body.comment.slice(0, 500) : ""

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return NextResponse.json(
        { error: "Rating must be an integer between 1 and 5" },
        { status: 400 }
      )
    }

    // Verify token signature and expiry
    const payload = verifyRatingToken(token)
    if (!payload) {
      return NextResponse.json(
        { error: "Invalid or expired rating link" },
        { status: 401 }
      )
    }

    const { loadId, shipperId } = payload
    const sql = getDb()

    // Compute token hash for dedup
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex")

    // Check for duplicate submission
    const existing = await sql`
      SELECT id FROM delivery_ratings WHERE token_hash = ${tokenHash} LIMIT 1
    `
    if (existing.length > 0) {
      return NextResponse.json(
        { error: "You have already submitted a rating for this delivery" },
        { status: 409 }
      )
    }

    // Insert rating
    const ratingId = `RTG-${Date.now().toString(36).toUpperCase()}`
    await sql`
      INSERT INTO delivery_ratings (id, load_id, shipper_id, rating, comment, token_hash)
      VALUES (${ratingId}, ${loadId}, ${shipperId}, ${rating}, ${comment}, ${tokenHash})
    `

    // Look up load reference for notification
    const loads = await sql`
      SELECT reference_number FROM loads WHERE id = ${loadId} LIMIT 1
    `
    const loadRef = loads.length > 0 ? loads[0].reference_number : loadId

    // Create notification for broker team
    await createNotification({
      type: "info",
      title: `Shipper rated delivery ${rating}/5 — Load ${loadRef}`,
      body: comment || `Rating: ${rating}/5`,
      link: `/loads/${loadId}`,
      loadId,
      userId: null,
    })

    return NextResponse.json({ success: true, rating })
  } catch (error) {
    console.error("[api/rate] Error:", error)
    return NextResponse.json(
      { error: "Failed to submit rating" },
      { status: 500 }
    )
  }
}
