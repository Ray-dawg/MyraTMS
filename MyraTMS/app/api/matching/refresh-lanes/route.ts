import { NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { extractRegion } from "@/lib/matching/regions"

/**
 * POST /api/matching/refresh-lanes
 * Refreshes the carrier_lanes cache table by aggregating load history.
 * Should be called periodically or after load delivery.
 */
export async function POST() {
  try {
    const sql = getDb()

    // Get all completed loads with carrier assignments from last 365 days
    const loads = await sql`
      SELECT
        carrier_id,
        origin,
        destination,
        equipment,
        carrier_cost,
        delivery_date,
        updated_at,
        created_at
      FROM loads
      WHERE carrier_id IS NOT NULL
        AND status IN ('Delivered', 'Invoiced', 'Closed')
        AND created_at > NOW() - INTERVAL '365 days'
      ORDER BY carrier_id, origin, destination
    `

    // Aggregate into lane stats
    const laneMap = new Map<
      string,
      {
        carrierId: string
        originRegion: string
        destRegion: string
        equipment: string
        rates: number[]
        dates: Date[]
        count: number
      }
    >()

    for (const load of loads) {
      const originRegion = extractRegion(load.origin as string)
      const destRegion = extractRegion(load.destination as string)
      const equipment = (load.equipment as string) || "Dry Van"
      const key = `${load.carrier_id}|${originRegion}|${destRegion}|${equipment}`

      if (!laneMap.has(key)) {
        laneMap.set(key, {
          carrierId: load.carrier_id as string,
          originRegion,
          destRegion,
          equipment,
          rates: [],
          dates: [],
          count: 0,
        })
      }

      const entry = laneMap.get(key)!
      entry.count++
      if (load.carrier_cost && Number(load.carrier_cost) > 0) {
        entry.rates.push(Number(load.carrier_cost))
      }
      if (load.created_at) {
        entry.dates.push(new Date(load.created_at as string))
      }
    }

    // Upsert into carrier_lanes
    let upserted = 0
    for (const lane of laneMap.values()) {
      const avgRate =
        lane.rates.length > 0
          ? lane.rates.reduce((a, b) => a + b, 0) / lane.rates.length
          : null
      const lastDate =
        lane.dates.length > 0
          ? lane.dates.sort((a, b) => b.getTime() - a.getTime())[0]
          : null

      const id = `CL-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).substring(2, 5).toUpperCase()}`

      await sql`
        INSERT INTO carrier_lanes (id, carrier_id, origin_region, dest_region, equipment_type, load_count, avg_carrier_rate, last_load_date, updated_at)
        VALUES (
          ${id},
          ${lane.carrierId},
          ${lane.originRegion},
          ${lane.destRegion},
          ${lane.equipment},
          ${lane.count},
          ${avgRate},
          ${lastDate?.toISOString().split("T")[0] || null},
          NOW()
        )
        ON CONFLICT (carrier_id, origin_region, dest_region, equipment_type)
        DO UPDATE SET
          load_count = EXCLUDED.load_count,
          avg_carrier_rate = EXCLUDED.avg_carrier_rate,
          last_load_date = EXCLUDED.last_load_date,
          updated_at = NOW()
      `
      upserted++
    }

    return NextResponse.json({
      status: "ok",
      lanes_processed: upserted,
      loads_analyzed: loads.length,
    })
  } catch (err) {
    console.error("Lane refresh error:", err)
    return NextResponse.json({ error: "Lane refresh failed" }, { status: 500 })
  }
}
