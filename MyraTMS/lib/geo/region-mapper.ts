/**
 * Region mapper — resolves lat/lng to a named region for rate lookups.
 * Ontario cities use 50km haversine radius; others fallback to province codes.
 */

export interface RegionResult {
  region: string
  city: string | null
  province: string
}

interface CityDef {
  name: string
  lat: number
  lng: number
}

const ONTARIO_CITIES: CityDef[] = [
  { name: "Toronto", lat: 43.6532, lng: -79.3832 },
  { name: "Ottawa", lat: 45.4215, lng: -75.6972 },
  { name: "Hamilton", lat: 43.2557, lng: -79.8711 },
  { name: "London", lat: 42.9849, lng: -81.2453 },
  { name: "Kitchener-Waterloo", lat: 43.4516, lng: -80.4925 },
  { name: "Windsor", lat: 42.3149, lng: -83.0364 },
  { name: "Sudbury", lat: 46.4917, lng: -80.9930 },
  { name: "Thunder Bay", lat: 48.3809, lng: -89.2477 },
  { name: "Barrie", lat: 44.3894, lng: -79.6903 },
  { name: "Kingston", lat: 44.2312, lng: -76.4860 },
  { name: "Peterborough", lat: 44.3091, lng: -78.3197 },
  { name: "Oshawa", lat: 43.8971, lng: -78.8658 },
  { name: "Sault Ste Marie", lat: 46.5219, lng: -84.3461 },
]

const RADIUS_KM = 50

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

/** Determine province from lat/lng (simplified Canadian bounds) */
function inferProvince(lat: number, lng: number): string {
  // Rough bounding boxes for Canadian provinces
  if (lat >= 41.7 && lat <= 56.9 && lng >= -95.2 && lng <= -74.3) return "ON"
  if (lat >= 45.0 && lat <= 62.6 && lng >= -79.8 && lng <= -57.1) return "QC"
  if (lat >= 43.4 && lat <= 48.1 && lng >= -67.0 && lng <= -59.7) return "NB"
  if (lat >= 43.4 && lat <= 47.0 && lng >= -66.5 && lng <= -59.7) return "NS"
  if (lat >= 49.0 && lat <= 60.0 && lng >= -139.1 && lng <= -114.1) return "BC"
  if (lat >= 49.0 && lat <= 60.0 && lng >= -120.0 && lng <= -110.0) return "AB"
  if (lat >= 49.0 && lat <= 60.0 && lng >= -110.0 && lng <= -101.4) return "SK"
  if (lat >= 49.0 && lat <= 60.0 && lng >= -101.4 && lng <= -88.9) return "MB"
  // US states — just label as US
  if (lat >= 24.5 && lat <= 49.4 && lng >= -125.0 && lng <= -66.9) return "US"
  return "OTHER"
}

export function normalizeRegion(lat: number, lng: number): RegionResult {
  const province = inferProvince(lat, lng)

  // Only do Ontario city matching for Ontario coords
  if (province === "ON") {
    let closest: CityDef | null = null
    let closestDist = Infinity

    for (const city of ONTARIO_CITIES) {
      const dist = haversineKm(lat, lng, city.lat, city.lng)
      if (dist < closestDist) {
        closestDist = dist
        closest = city
      }
    }

    if (closest && closestDist <= RADIUS_KM) {
      return { region: closest.name, city: closest.name, province: "ON" }
    }

    // Rural Ontario quadrants
    const midLat = 45.5
    const midLng = -80.0
    if (lat >= midLat && lng >= midLng) return { region: "ON-Rural-East", city: null, province: "ON" }
    if (lat >= midLat && lng < midLng) return { region: "ON-Rural-North", city: null, province: "ON" }
    if (lat < midLat && lng >= midLng) return { region: "ON-Rural-South", city: null, province: "ON" }
    return { region: "ON-Rural-West", city: null, province: "ON" }
  }

  // Non-Ontario — just use province code
  return { region: province, city: null, province }
}
