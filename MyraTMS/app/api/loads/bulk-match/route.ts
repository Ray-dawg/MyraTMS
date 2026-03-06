import { NextRequest, NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { matchCarriers, type MatchGrade } from "@/lib/matching"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { load_ids, min_grade = "C" } = body as {
      load_ids: string[]
      min_grade?: MatchGrade
    }

    if (!load_ids || !Array.isArray(load_ids) || load_ids.length === 0) {
      return NextResponse.json({ error: "load_ids array is required" }, { status: 400 })
    }

    if (load_ids.length > 50) {
      return NextResponse.json({ error: "Maximum 50 loads per bulk match" }, { status: 400 })
    }

    const sql = getDb()

    const results: {
      load_id: string
      top_match: {
        carrier_id: string
        carrier_name: string
        score: number
        grade: string
      } | null
      total_eligible: number
    }[] = []

    for (const loadId of load_ids) {
      const loads = await sql`
        SELECT id, origin, destination, origin_lat, origin_lng,
               equipment, carrier_cost, revenue, status, carrier_id
        FROM loads WHERE id = ${loadId}
      `

      if (loads.length === 0) {
        results.push({ load_id: loadId, top_match: null, total_eligible: 0 })
        continue
      }

      const load = loads[0]

      // Skip already-assigned loads
      if (load.carrier_id) {
        results.push({ load_id: loadId, top_match: null, total_eligible: 0 })
        continue
      }

      const matchResult = await matchCarriers(sql, {
        loadId,
        origin: load.origin as string,
        destination: load.destination as string,
        originLat: load.origin_lat != null ? Number(load.origin_lat) : null,
        originLng: load.origin_lng != null ? Number(load.origin_lng) : null,
        equipmentType: (load.equipment as string) || "Dry Van",
        carrierCost: Number(load.carrier_cost) || 0,
        revenue: Number(load.revenue) || 0,
        maxResults: 1,
        minGrade: min_grade,
      })

      const top = matchResult.matches[0] || null
      results.push({
        load_id: loadId,
        top_match: top
          ? {
              carrier_id: top.carrier_id,
              carrier_name: top.carrier_name,
              score: top.match_score,
              grade: top.match_grade,
            }
          : null,
        total_eligible: matchResult.total_eligible_carriers,
      })
    }

    return NextResponse.json({ matches: results })
  } catch (err) {
    console.error("Bulk match error:", err)
    return NextResponse.json({ error: "Bulk matching failed" }, { status: 500 })
  }
}
