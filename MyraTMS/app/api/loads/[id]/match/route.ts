import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { requireTenantContext } from "@/lib/auth"
import { matchCarriersWithClient, storeMatchResults, type MatchGrade } from "@/lib/matching"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = requireTenantContext(req)
    const { id: loadId } = await params
    const body = await req.json().catch(() => ({}))

    const { result, status } = await withTenant(ctx.tenantId, async (client) => {
      const { rows: loads } = await client.query(
        `SELECT id, origin, destination, origin_lat, origin_lng,
                equipment, carrier_cost, revenue, status
           FROM loads WHERE id = $1`,
        [loadId],
      )
      if (loads.length === 0) {
        return { result: null, status: "not_found" as const }
      }
      const load = loads[0]

      const matchResult = await matchCarriersWithClient(client, {
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

      return { result: matchResult, status: "ok" as const }
    })

    if (status === "not_found") {
      return NextResponse.json({ error: "Load not found" }, { status: 404 })
    }

    if (result && result.matches.length > 0) {
      await storeMatchResults(ctx.tenantId, loadId, result.matches).catch((err) => {
        console.error("Failed to store match results:", err)
      })
    }

    return NextResponse.json(result)
  } catch (err) {
    console.error("Match error:", err)
    return NextResponse.json({ error: "Matching failed" }, { status: 500 })
  }
}
