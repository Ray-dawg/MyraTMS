import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"

/**
 * POST /api/carriers/:id/rate
 * Rate a carrier's communication after load delivery (1-5 stars).
 * Updates running average on the carrier record.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: carrierId } = await params
    const body = await req.json()
    const { rating, load_id } = body as { rating: number; load_id?: string }

    if (!rating || rating < 1 || rating > 5) {
      return NextResponse.json(
        { error: "Rating must be between 1 and 5" },
        { status: 400 }
      )
    }

    const sql = getDb()

    // Verify carrier exists
    const carriers = await sql`
      SELECT id, communication_rating FROM carriers WHERE id = ${carrierId}
    `
    if (carriers.length === 0) {
      return NextResponse.json({ error: "Carrier not found" }, { status: 404 })
    }

    const currentRating = carriers[0].communication_rating
      ? Number(carriers[0].communication_rating)
      : 3.0

    // Running average: new_avg = (old_avg * 0.8) + (new_rating * 0.2)
    // This weights recent ratings more heavily
    const newRating = Math.round((currentRating * 0.8 + rating * 0.2) * 100) / 100

    await sql`
      UPDATE carriers
      SET communication_rating = ${newRating}, updated_at = NOW()
      WHERE id = ${carrierId}
    `

    // If load_id provided, record the rating event
    if (load_id) {
      await sql`
        INSERT INTO activity_notes (id, related_to, related_type, type, content, created_by)
        VALUES (
          ${"NOTE-" + Date.now().toString(36).toUpperCase()},
          ${load_id},
          'Load',
          'System',
          ${"Carrier rated " + rating + "/5 stars for communication"},
          'System'
        )
      `.catch(() => {})
    }

    return NextResponse.json({
      carrier_id: carrierId,
      previous_rating: currentRating,
      new_rating: newRating,
      submitted_rating: rating,
    })
  } catch (err) {
    console.error("Rate carrier error:", err)
    return NextResponse.json({ error: "Rating failed" }, { status: 500 })
  }
}
