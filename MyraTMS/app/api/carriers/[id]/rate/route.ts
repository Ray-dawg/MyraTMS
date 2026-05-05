import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = requireTenantContext(req)
    const { id: carrierId } = await params
    const body = await req.json()
    const { rating, load_id } = body as { rating: number; load_id?: string }

    if (!rating || rating < 1 || rating > 5) {
      return NextResponse.json({ error: "Rating must be between 1 and 5" }, { status: 400 })
    }

    const result = await withTenant(ctx.tenantId, async (client) => {
      const { rows: carriers } = await client.query(
        `SELECT id, communication_rating FROM carriers WHERE id = $1`,
        [carrierId],
      )
      if (carriers.length === 0) return { notFound: true as const }

      const currentRating = carriers[0].communication_rating
        ? Number(carriers[0].communication_rating)
        : 3.0

      const newRating = Math.round((currentRating * 0.8 + rating * 0.2) * 100) / 100

      await client.query(
        `UPDATE carriers SET communication_rating = $1, updated_at = NOW() WHERE id = $2`,
        [newRating, carrierId],
      )

      if (load_id) {
        try {
          await client.query(
            `INSERT INTO activity_notes (id, related_to, related_type, type, content, created_by)
             VALUES ($1, $2, 'Load', 'System', $3, 'System')`,
            [
              `NOTE-${Date.now().toString(36).toUpperCase()}`,
              load_id,
              `Carrier rated ${rating}/5 stars for communication`,
            ],
          )
        } catch {
          // tolerate activity_notes insert failures
        }
      }

      return { currentRating, newRating }
    })

    if ("notFound" in result) {
      return NextResponse.json({ error: "Carrier not found" }, { status: 404 })
    }

    return NextResponse.json({
      carrier_id: carrierId,
      previous_rating: result.currentRating,
      new_rating: result.newRating,
      submitted_rating: rating,
    })
  } catch (err) {
    console.error("Rate carrier error:", err)
    return NextResponse.json({ error: "Rating failed" }, { status: 500 })
  }
}
