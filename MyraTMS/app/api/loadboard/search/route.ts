import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { getCached, setCache } from "@/lib/redis"

interface LoadboardResult {
  id: string
  source: string
  origin: string
  origin_state: string
  destination: string
  destination_state: string
  equipment: string
  weight: string
  miles: number
  rate: number
  rate_per_mile: number
  pickup_date: string
  delivery_date: string
  shipper_name: string
  age: string
  commodity: string
}

const MOCK_LOADS: LoadboardResult[] = [
  { id: "EXT-001", source: "DAT", origin: "Indianapolis, IN", origin_state: "IN", destination: "St. Louis, MO", destination_state: "MO", equipment: "Dry Van 53'", weight: "40,000 lbs", miles: 243, rate: 2100, rate_per_mile: 8.64, pickup_date: "2026-02-17", delivery_date: "2026-02-17", shipper_name: "Central Distributors", age: "2h ago", commodity: "Consumer Goods" },
  { id: "EXT-002", source: "DAT", origin: "Chicago, IL", origin_state: "IL", destination: "Nashville, TN", destination_state: "TN", equipment: "Reefer 53'", weight: "38,000 lbs", miles: 474, rate: 3800, rate_per_mile: 8.02, pickup_date: "2026-02-18", delivery_date: "2026-02-19", shipper_name: "Midwest Cold Storage", age: "45m ago", commodity: "Frozen Foods" },
  { id: "EXT-003", source: "Truckstop", origin: "Dallas, TX", origin_state: "TX", destination: "Houston, TX", destination_state: "TX", equipment: "Flatbed 48'", weight: "44,000 lbs", miles: 240, rate: 1800, rate_per_mile: 7.50, pickup_date: "2026-02-17", delivery_date: "2026-02-17", shipper_name: "Texas Steel Works", age: "1h ago", commodity: "Steel Beams" },
  { id: "EXT-004", source: "Truckstop", origin: "Atlanta, GA", origin_state: "GA", destination: "Jacksonville, FL", destination_state: "FL", equipment: "Dry Van 53'", weight: "35,000 lbs", miles: 346, rate: 2600, rate_per_mile: 7.51, pickup_date: "2026-02-18", delivery_date: "2026-02-19", shipper_name: "Peach State Logistics", age: "3h ago", commodity: "Paper Products" },
  { id: "EXT-005", source: "DAT", origin: "Phoenix, AZ", origin_state: "AZ", destination: "Los Angeles, CA", destination_state: "CA", equipment: "Dry Van 53'", weight: "30,000 lbs", miles: 373, rate: 2400, rate_per_mile: 6.43, pickup_date: "2026-02-17", delivery_date: "2026-02-18", shipper_name: "Desert Imports LLC", age: "30m ago", commodity: "Electronics" },
  { id: "EXT-006", source: "DAT", origin: "Memphis, TN", origin_state: "TN", destination: "Birmingham, AL", destination_state: "AL", equipment: "Dry Van 53'", weight: "42,000 lbs", miles: 244, rate: 1950, rate_per_mile: 7.99, pickup_date: "2026-02-18", delivery_date: "2026-02-18", shipper_name: "River City Supply", age: "4h ago", commodity: "Auto Parts" },
  { id: "EXT-007", source: "Truckstop", origin: "Portland, OR", origin_state: "OR", destination: "Seattle, WA", destination_state: "WA", equipment: "Reefer 53'", weight: "36,000 lbs", miles: 174, rate: 1600, rate_per_mile: 9.20, pickup_date: "2026-02-17", delivery_date: "2026-02-17", shipper_name: "Pacific Seafood Co", age: "1h ago", commodity: "Fresh Seafood" },
  { id: "EXT-008", source: "Truckstop", origin: "Kansas City, MO", origin_state: "MO", destination: "Denver, CO", destination_state: "CO", equipment: "Dry Van 53'", weight: "38,000 lbs", miles: 606, rate: 4200, rate_per_mile: 6.93, pickup_date: "2026-02-19", delivery_date: "2026-02-20", shipper_name: "Plains Manufacturing", age: "2h ago", commodity: "Machinery" },
  { id: "EXT-009", source: "DAT", origin: "Charlotte, NC", origin_state: "NC", destination: "Richmond, VA", destination_state: "VA", equipment: "Dry Van 53'", weight: "28,000 lbs", miles: 330, rate: 2200, rate_per_mile: 6.67, pickup_date: "2026-02-18", delivery_date: "2026-02-19", shipper_name: "Southeastern Paper", age: "5h ago", commodity: "Paper & Pulp" },
  { id: "EXT-010", source: "DAT", origin: "Detroit, MI", origin_state: "MI", destination: "Chicago, IL", destination_state: "IL", equipment: "Flatbed 48'", weight: "46,000 lbs", miles: 282, rate: 2800, rate_per_mile: 9.93, pickup_date: "2026-02-17", delivery_date: "2026-02-18", shipper_name: "Great Lakes Auto", age: "15m ago", commodity: "Auto Frames" },
  { id: "EXT-011", source: "DAT", origin: "Houston, TX", origin_state: "TX", destination: "New Orleans, LA", destination_state: "LA", equipment: "Tanker", weight: "45,000 lbs", miles: 349, rate: 4500, rate_per_mile: 12.89, pickup_date: "2026-02-18", delivery_date: "2026-02-19", shipper_name: "Gulf Petrochemical", age: "1h ago", commodity: "Chemicals" },
  { id: "EXT-012", source: "Truckstop", origin: "Minneapolis, MN", origin_state: "MN", destination: "Des Moines, IA", destination_state: "IA", equipment: "Hopper", weight: "48,000 lbs", miles: 244, rate: 2100, rate_per_mile: 8.61, pickup_date: "2026-02-19", delivery_date: "2026-02-19", shipper_name: "Northern Ag Supply", age: "3h ago", commodity: "Grain" },
]

async function searchDAT(apiKey: string, origin?: string, destination?: string, equipment?: string): Promise<LoadboardResult[]> {
  try {
    const res = await fetch("https://api.dat.com/search/loads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        origin: origin || undefined,
        destination: destination || undefined,
        equipmentType: equipment || undefined,
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.loads || data.results || []).map((l: Record<string, unknown>, idx: number) => ({
      id: `DAT-${idx}-${Date.now().toString(36)}`,
      source: "DAT",
      origin: (l.originCity as string) || "",
      origin_state: (l.originState as string) || "",
      destination: (l.destinationCity as string) || "",
      destination_state: (l.destinationState as string) || "",
      equipment: (l.equipmentType as string) || "",
      weight: (l.weight as string) || "N/A",
      miles: (l.miles as number) || 0,
      rate: (l.rate as number) || 0,
      rate_per_mile: (l.miles as number) ? ((l.rate as number) || 0) / ((l.miles as number) || 1) : 0,
      pickup_date: (l.pickupDate as string) || "",
      delivery_date: (l.deliveryDate as string) || "",
      shipper_name: (l.shipperName as string) || "Unknown",
      age: "Just posted",
      commodity: (l.commodity as string) || "General",
    }))
  } catch (err) {
    console.error("[DAT] Search failed:", err)
    return []
  }
}

async function searchTruckstop(apiKey: string, origin?: string, destination?: string, equipment?: string): Promise<LoadboardResult[]> {
  try {
    const params = new URLSearchParams()
    if (origin) params.set("origin", origin)
    if (destination) params.set("destination", destination)
    if (equipment) params.set("equipmentType", equipment)
    const res = await fetch(`https://api.truckstop.com/search/v2/loads?${params.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.loads || data.results || []).map((l: Record<string, unknown>, idx: number) => ({
      id: `TS-${idx}-${Date.now().toString(36)}`,
      source: "Truckstop",
      origin: (l.originCity as string) || "",
      origin_state: (l.originState as string) || "",
      destination: (l.destinationCity as string) || "",
      destination_state: (l.destinationState as string) || "",
      equipment: (l.equipmentType as string) || "",
      weight: (l.weight as string) || "N/A",
      miles: (l.miles as number) || 0,
      rate: (l.rate as number) || 0,
      rate_per_mile: (l.miles as number) ? ((l.rate as number) || 0) / ((l.miles as number) || 1) : 0,
      pickup_date: (l.pickupDate as string) || "",
      delivery_date: (l.deliveryDate as string) || "",
      shipper_name: (l.shipperName as string) || "Unknown",
      age: "Just posted",
      commodity: (l.commodity as string) || "General",
    }))
  } catch (err) {
    console.error("[Truckstop] Search failed:", err)
    return []
  }
}

function deduplicateLoads(loads: LoadboardResult[]): LoadboardResult[] {
  const seen = new Map<string, LoadboardResult>()
  for (const load of loads) {
    const key = `${load.origin.toLowerCase().trim()}|${load.destination.toLowerCase().trim()}|${load.pickup_date}`
    if (!seen.has(key)) seen.set(key, load)
  }
  return Array.from(seen.values())
}

export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)
  const ctx = requireTenantContext(req)

  let body: { origin?: string; destination?: string; equipment?: string; maxAge?: number }
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const { origin, destination, equipment } = body
  const datKey = process.env.DAT_API_KEY
  const truckstopKey = process.env.TRUCKSTOP_API_KEY
  const apiConnected = !!(datKey || truckstopKey)

  // Cache key includes tenant — different tenants must not see each other's cached searches
  const cacheKey = `loadboard:search:t${ctx.tenantId}:${(origin || "any").toLowerCase()}:${(destination || "any").toLowerCase()}:${(equipment || "any").toLowerCase()}`
  const TTL = 4 * 3600

  const cached = await getCached<{ loads: LoadboardResult[]; sources: string[] }>(cacheKey)
  if (cached) {
    let filtered = cached.loads
    if (origin) {
      const q = origin.toLowerCase()
      filtered = filtered.filter((l) =>
        l.origin.toLowerCase().includes(q) || l.origin_state.toLowerCase().includes(q),
      )
    }
    if (destination) {
      const q = destination.toLowerCase()
      filtered = filtered.filter((l) =>
        l.destination.toLowerCase().includes(q) || l.destination_state.toLowerCase().includes(q),
      )
    }
    if (equipment) {
      const q = equipment.toLowerCase()
      filtered = filtered.filter((l) => l.equipment.toLowerCase().includes(q))
    }
    return NextResponse.json({
      loads: filtered,
      total: filtered.length,
      sources: cached.sources,
      api_connected: apiConnected,
      cached: true,
      last_sync: new Date().toISOString(),
    })
  }

  if (apiConnected) {
    const sources: string[] = []
    const allLoads: LoadboardResult[] = []
    if (datKey) {
      const datResults = await searchDAT(datKey, origin, destination, equipment)
      allLoads.push(...datResults)
      if (datResults.length > 0) sources.push("DAT")
    }
    if (truckstopKey) {
      const tsResults = await searchTruckstop(truckstopKey, origin, destination, equipment)
      allLoads.push(...tsResults)
      if (tsResults.length > 0) sources.push("Truckstop")
    }
    const deduped = deduplicateLoads(allLoads)
    if (deduped.length > 0) {
      await setCache(cacheKey, { loads: deduped, sources }, TTL)
    }
    return NextResponse.json({
      loads: deduped,
      total: deduped.length,
      sources,
      api_connected: true,
      cached: false,
      last_sync: new Date().toISOString(),
    })
  }

  let results = [...MOCK_LOADS]
  if (origin) {
    const q = origin.toLowerCase()
    results = results.filter((l) =>
      l.origin.toLowerCase().includes(q) || l.origin_state.toLowerCase().includes(q),
    )
  }
  if (destination) {
    const q = destination.toLowerCase()
    results = results.filter((l) =>
      l.destination.toLowerCase().includes(q) || l.destination_state.toLowerCase().includes(q),
    )
  }
  if (equipment) {
    const q = equipment.toLowerCase()
    results = results.filter((l) => l.equipment.toLowerCase().includes(q))
  }

  return NextResponse.json({
    loads: results,
    total: results.length,
    sources: ["DAT", "Truckstop"],
    api_connected: false,
    cached: false,
    last_sync: new Date().toISOString(),
  })
}
