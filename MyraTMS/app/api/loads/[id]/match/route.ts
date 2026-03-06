import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { matchCarriers, storeMatchResults, type MatchGrade } from "@/lib/matching"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: loadId } = await params
    const body = await req.json().catch(() => ({}))

    const sql = getDb()

    // Fetch the load
    const loads = await sql`
      SELECT id, origin, destination, origin_lat, origin_lng,
             equipment, carrier_cost, revenue, status
      FROM loads WHERE id = ${loadId}
    `

    if (loads.length === 0) {
      return NextResponse.json({ error: "Load not found" }, { status: 404 })
    }

    const load = loads[0]

    // Run the matching engine
    const result = await matchCarriers(sql, {
      loadId,
      origin: load.origin as string,
      destination: load.destination as string,
      originLat: load.origin_lat != null ? Number(load.origin_lat) : null,
      originLng: load.origin_lng != null ? Number(load.origin_lng) : null,
      equipmentType: (load.equipment as string) || "Dry Van",
      carrierCost: Number(load.carrier_cost) || 0,
      revenue: Number(load.revenue) || 0,
      maxResults: body.max_results || 5,
      minGrade: (body.min_grade as MatchGrade) || undefined,
      excludeCarriers: body.exclude_carriers || [],
    })

    // Store results for learning/audit
    if (result.matches.length > 0) {
      await storeMatchResults(sql, loadId, result.matches).catch((err) => {
        console.error("Failed to store match results:", err)
      })
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error("Match error:", err)
    return NextResponse.json({ error: "Matching failed" }, { status: 500 })
  }
}
