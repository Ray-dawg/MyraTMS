import { notFound } from "next/navigation"
import { TrackingClient } from "./tracking-client"

interface TrackingDocument {
  id: string
  name: string
  type: string
  uploadDate: string | null
  blobUrl: string | null
  fileSize: number | null
}

interface TrackingAPIResponse {
  loadNumber: string
  referenceNumber: string | null
  poNumber: string | null
  status: string
  carrier: string
  shipper: string
  origin: {
    city: string
    state: string
    lat: number | null
    lng: number | null
    date: string | null
  }
  destination: {
    city: string
    state: string
    lat: number | null
    lng: number | null
    date: string | null
  }
  currentLat: number | null
  currentLng: number | null
  currentEta: string | null
  commodity: string
  weight: string
  equipment: string
  events: Array<{
    id: string
    eventType: string
    status: string
    location: string
    note: string
    createdAt: string
  }>
  isDelivered: boolean
  podUrl: string | null
  driver: { firstName: string; phone: string } | null
  lastUpdated: string
}

/** Map TMS status strings to the status values the tracking UI components expect */
function mapStatus(
  status: string
): "booked" | "picked_up" | "in_transit" | "break_point" | "docking" | "delivered" {
  const s = status.toLowerCase().replace(/\s+/g, "_")
  const statusMap: Record<string, "booked" | "picked_up" | "in_transit" | "break_point" | "docking" | "delivered"> = {
    created: "booked",
    quoted: "booked",
    booked: "booked",
    assigned: "booked",
    accepted: "booked",
    at_pickup: "picked_up",
    picked_up: "picked_up",
    in_transit: "in_transit",
    at_delivery: "docking",
    delivered: "delivered",
    invoiced: "delivered",
    paid: "delivered",
    // Legacy uppercase statuses from existing data
    dispatched: "in_transit",
  }
  return statusMap[s] || "in_transit"
}

/** Calculate progress (0-1) based on status */
function statusToProgress(status: string): number {
  const s = status.toLowerCase().replace(/\s+/g, "_")
  const progressMap: Record<string, number> = {
    created: 0.0,
    quoted: 0.05,
    booked: 0.1,
    assigned: 0.15,
    accepted: 0.2,
    at_pickup: 0.25,
    picked_up: 0.3,
    in_transit: 0.55,
    at_delivery: 0.85,
    docking: 0.9,
    delivered: 1.0,
    invoiced: 1.0,
    paid: 1.0,
    dispatched: 0.4,
  }
  return progressMap[s] ?? 0.5
}

/** Format a date string for display */
function formatDate(dateStr: string | null): { date: string; time: string } {
  if (!dateStr) return { date: "TBD", time: "" }
  try {
    const d = new Date(dateStr)
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return {
      date: `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}`,
      time: d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" }) + " EST",
    }
  } catch {
    return { date: dateStr, time: "" }
  }
}

/** Format a relative timestamp like "2 min ago" */
function formatLastUpdated(isoStr: string): string {
  try {
    const d = new Date(isoStr)
    const diffMs = Date.now() - d.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return "Just now"
    if (diffMin < 60) return `${diffMin} min ago`
    const diffHrs = Math.floor(diffMin / 60)
    if (diffHrs < 24) return `${diffHrs}h ago`
    return `${Math.floor(diffHrs / 24)}d ago`
  } catch {
    return "Unknown"
  }
}

/** Map API events to the timeline event shape the UI expects */
function mapEvents(
  apiEvents: TrackingAPIResponse["events"],
  status: string,
  isDelivered: boolean
) {
  // If we have real events, use them
  if (apiEvents.length > 0) {
    const mappedStatus = mapStatus(status)
    return apiEvents
      .slice()
      .reverse() // oldest first
      .map((e, idx) => {
        const isActive = idx === apiEvents.length - 1 && !isDelivered
        return {
          id: e.eventType || e.id,
          status: e.status || e.eventType,
          location: e.location || "",
          timestamp: e.createdAt
            ? new Date(e.createdAt).toLocaleString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
              })
            : "",
          note: e.note || "",
          completed: !isActive,
          active: isActive,
        }
      })
  }

  // Fallback: generate synthetic events based on status
  const mappedStatus = mapStatus(status)
  const steps = [
    { id: "booked", status: "Load Booked" },
    { id: "picked_up", status: "Picked Up" },
    { id: "in_transit", status: "In Transit" },
    { id: "delivered", status: "Delivered" },
  ]

  const statusOrder = ["booked", "picked_up", "in_transit", "delivered"]
  const currentIdx = statusOrder.indexOf(
    mappedStatus === "break_point" || mappedStatus === "docking" ? "in_transit" : mappedStatus
  )

  return steps.map((step, idx) => ({
    id: step.id,
    status: step.status,
    location: "",
    timestamp: "",
    note: "",
    completed: idx < currentIdx || (idx === currentIdx && isDelivered),
    active: idx === currentIdx && !isDelivered,
  }))
}

/**
 * Reverse geocode coordinates to a human-readable "City, State" string
 * using the free Nominatim (OpenStreetMap) API.
 * Returns null if the lookup fails so the caller can fall back.
 */
async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      {
        headers: { "User-Agent": "MyraTMS/1.0" },
        next: { revalidate: 300 }, // cache for 5 minutes
      }
    )

    if (!res.ok) return null

    const json = await res.json()
    const addr = json?.address
    if (!addr) return null

    // Nominatim returns city, town, village, or hamlet depending on size
    const city =
      addr.city || addr.town || addr.village || addr.hamlet || addr.county || null
    const state = addr.state || null

    if (!city && !state) return null

    // Format as "City, State" or just the available part
    if (city && state) return `${city}, ${state}`
    return city || state || null
  } catch (err) {
    console.error("[tracking] Reverse geocoding failed:", err)
    return null
  }
}

/**
 * Derive the best "current city" display string.
 * Priority:
 *   1. Reverse-geocoded coordinates (if lat/lng available)
 *   2. Most recent event location text
 *   3. Origin city/state fallback
 */
async function resolveCurrentCity(
  data: TrackingAPIResponse
): Promise<string> {
  // 1. Try reverse geocoding from live coordinates
  if (data.currentLat != null && data.currentLng != null) {
    const geocoded = await reverseGeocode(data.currentLat, data.currentLng)
    if (geocoded) return geocoded
  }

  // 2. Fall back to the most recent event's location text
  if (data.events.length > 0) {
    // Events come newest-first from the API
    const latestLocation = data.events[0]?.location
    if (latestLocation) return latestLocation
  }

  // 3. Last resort: origin city
  return `${data.origin.city || "Origin"}, ${data.origin.state || ""}`
}

/**
 * Server component: fetches tracking data from MyraTMS API
 * and renders the tracking client with mapped data.
 */
export default async function TrackingTokenPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000"

  // Fetch load data and documents in parallel
  const [loadResult, docsResult] = await Promise.allSettled([
    fetch(`${apiUrl}/api/tracking/${token}`, { cache: "no-store" }),
    fetch(`${apiUrl}/api/tracking/${token}/documents`, { cache: "no-store" }),
  ])

  // Handle load result — required
  let data: TrackingAPIResponse
  if (loadResult.status === "rejected") {
    console.error("[tracking] Failed to fetch tracking data:", loadResult.reason)
    notFound()
  }

  const loadRes = loadResult.value
  if (loadRes.status === 404 || loadRes.status === 410) {
    notFound()
  }
  if (!loadRes.ok) {
    console.error("[tracking] API responded with", loadRes.status)
    notFound()
  }

  data = await loadRes.json()

  // Handle documents result — optional, default to empty
  let documents: TrackingDocument[] = []
  if (docsResult.status === "fulfilled" && docsResult.value.ok) {
    try {
      const docsJson = await docsResult.value.json()
      documents = docsJson.documents || []
    } catch {
      // Documents fetch failed, continue without them
    }
  }

  // Map API response to the MOCK_SHIPMENT shape
  const originDate = formatDate(data.origin.date)
  const destDate = formatDate(data.destination.date)
  const mappedStatus = mapStatus(data.status)
  const progress = statusToProgress(data.status)

  // Resolve current city via reverse geocoding (with fallback)
  const currentCity = await resolveCurrentCity(data)

  const etaDisplay = data.currentEta
    ? new Date(data.currentEta).toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "America/New_York",
      }) + " EST"
    : destDate.date && destDate.time
      ? `${destDate.date} · ${destDate.time}`
      : "Calculating..."

  const shipment = {
    loadNumber: data.loadNumber,
    poNumber: [data.poNumber, data.referenceNumber].filter(Boolean).join(" / ") || data.loadNumber,
    carrier: data.carrier || "Carrier TBD",
    lastUpdated: formatLastUpdated(data.lastUpdated),
    status: mappedStatus,
    progress,
    eta: etaDisplay,
    currentCity,
    miles: 0, // Will be calculated in client if coords available
    origin: {
      city: data.origin.city || "Origin",
      state: data.origin.state || "",
      address: `${data.origin.city || ""}, ${data.origin.state || ""}`,
      date: originDate.date,
      time: originDate.time,
      lat: data.origin.lat,
      lng: data.origin.lng,
    },
    destination: {
      city: data.destination.city || "Destination",
      state: data.destination.state || "",
      address: `${data.destination.city || ""}, ${data.destination.state || ""}`,
      date: destDate.date,
      time: destDate.time,
      lat: data.destination.lat,
      lng: data.destination.lng,
    },
    currentLat: data.currentLat,
    currentLng: data.currentLng,
    commodity: data.commodity || "General Freight",
    weight: data.weight || "N/A",
    pieces: 0,
    shipper: data.shipper || "Shipper",
    events: mapEvents(data.events, data.status, data.isDelivered),
    isDelivered: data.isDelivered,
    podUrl: data.podUrl || undefined,
    driver: data.driver,
  }

  return (
    <TrackingClient
      shipment={shipment}
      token={token}
      apiUrl={apiUrl}
      documents={documents}
    />
  )
}
