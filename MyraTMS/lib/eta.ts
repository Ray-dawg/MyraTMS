// ---------------------------------------------------------------------------
// ETA calculation engine for MyraTMS
//
// Uses the Haversine formula for great-circle distance and a configurable
// average speed to estimate arrival time. Also provides proactive exception
// detection for late shipments, missing GPS pings, and stationary trucks.
// ---------------------------------------------------------------------------

const EARTH_RADIUS_MILES = 3958.8

/** Convert degrees to radians */
function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/**
 * Calculate the great-circle distance between two lat/lng points using
 * the Haversine formula.
 * @returns Distance in miles
 */
export function haversine(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return EARTH_RADIUS_MILES * c
}

/**
 * Calculate estimated time of arrival based on current position,
 * destination, and average driving speed.
 */
export function calculateETA(
  currentLat: number,
  currentLng: number,
  destLat: number,
  destLng: number,
  avgSpeedMph: number = 55
): {
  distanceMiles: number
  estimatedMinutes: number
  estimatedArrival: Date
} {
  const distanceMiles = haversine(currentLat, currentLng, destLat, destLng)
  const estimatedMinutes = (distanceMiles / avgSpeedMph) * 60
  const estimatedArrival = new Date(Date.now() + estimatedMinutes * 60 * 1000)

  return {
    distanceMiles: Math.round(distanceMiles * 10) / 10,
    estimatedMinutes: Math.round(estimatedMinutes),
    estimatedArrival,
  }
}

export interface LoadException {
  type: string
  severity: "warning" | "critical"
  message: string
}

/**
 * Check for proactive exceptions on a load based on ETA and GPS data.
 *
 * Exceptions triggered:
 * - ETA exceeds scheduled delivery by > 30 minutes
 * - No GPS ping received in > 15 minutes
 * - Truck stationary for > 2 hours at pickup (possible detention)
 */
export function checkExceptions(
  load: {
    delivery_date?: string | null
    updated_at?: string | null
    status?: string | null
    current_lat?: number | null
    current_lng?: number | null
    origin_lat?: number | null
    origin_lng?: number | null
  },
  eta: Date
): LoadException[] {
  const exceptions: LoadException[] = []

  // 1. Delay > 30 minutes past scheduled delivery
  if (load.delivery_date) {
    const scheduledDelivery = new Date(load.delivery_date)
    const delayMs = eta.getTime() - scheduledDelivery.getTime()
    const delayMinutes = delayMs / (60 * 1000)

    if (delayMinutes > 30) {
      const hours = Math.floor(delayMinutes / 60)
      const mins = Math.round(delayMinutes % 60)
      exceptions.push({
        type: "late_delivery",
        severity: delayMinutes > 120 ? "critical" : "warning",
        message: `ETA is ${hours > 0 ? `${hours}h ` : ""}${mins}min past scheduled delivery`,
      })
    }
  }

  // 2. No GPS ping in > 15 minutes
  if (load.updated_at) {
    const lastUpdate = new Date(load.updated_at)
    const gapMs = Date.now() - lastUpdate.getTime()
    const gapMinutes = gapMs / (60 * 1000)

    if (gapMinutes > 15) {
      exceptions.push({
        type: "missing_ping",
        severity: gapMinutes > 60 ? "critical" : "warning",
        message: `No GPS update received in ${Math.round(gapMinutes)} minutes`,
      })
    }
  }

  // 3. Stationary at pickup for > 2 hours (possible detention)
  if (
    load.status === "at_pickup" &&
    load.current_lat != null &&
    load.current_lng != null &&
    load.origin_lat != null &&
    load.origin_lng != null
  ) {
    const distFromPickup = haversine(
      load.current_lat,
      load.current_lng,
      load.origin_lat,
      load.origin_lng
    )
    // Within 0.5 miles of pickup → consider stationary at pickup
    if (distFromPickup < 0.5 && load.updated_at) {
      const atPickupSince = new Date(load.updated_at)
      const hoursAtPickup = (Date.now() - atPickupSince.getTime()) / (3600 * 1000)
      if (hoursAtPickup > 2) {
        exceptions.push({
          type: "detention_risk",
          severity: "warning",
          message: `Truck stationary at pickup for ${Math.round(hoursAtPickup * 10) / 10} hours — possible detention`,
        })
      }
    }
  }

  return exceptions
}
