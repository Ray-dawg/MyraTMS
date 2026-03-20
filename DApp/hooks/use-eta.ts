'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Load } from '@/lib/mock-data'

interface ETAState {
  /** Remaining time in seconds */
  remainingSeconds: number
  /** Formatted string like "2h 14m" */
  formatted: string
  /** Distance remaining in miles */
  distanceMiles: number
  /** Whether driver is within geofence of next stop */
  withinGeofence: boolean
  /** Which stop is the geofence target */
  geofenceTarget: 'pickup' | 'delivery' | null
}

const GEOFENCE_RADIUS_MILES = 0.5
const AVG_SPEED_MPH = 55 // average truck speed

function haversineDistance(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 3959 // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function formatETA(seconds: number): string {
  if (seconds <= 0) return 'Arriving'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function useETA(
  load: Load | undefined,
  driverPosition: { latitude: number; longitude: number } | null | undefined
): ETAState {
  const [state, setState] = useState<ETAState>({
    remainingSeconds: 0,
    formatted: '--',
    distanceMiles: 0,
    withinGeofence: false,
    geofenceTarget: null,
  })

  const prevGeofenceRef = useRef(false)

  const calculate = useCallback(() => {
    if (!load || !driverPosition) {
      setState({
        remainingSeconds: 0,
        formatted: '--',
        distanceMiles: 0,
        withinGeofence: false,
        geofenceTarget: null,
      })
      return
    }

    // Determine target stop based on status
    const isPickupPhase = ['assigned', 'en_route_pickup'].includes(load.status)
    const isDeliveryPhase = ['loaded', 'en_route_delivery'].includes(load.status)
    const target = isPickupPhase ? load.pickup : load.delivery
    const geofenceTarget = isPickupPhase ? 'pickup' as const : isDeliveryPhase ? 'delivery' as const : null

    if (!geofenceTarget) {
      setState((prev) => ({ ...prev, formatted: '--', withinGeofence: false, geofenceTarget: null }))
      return
    }

    const distance = haversineDistance(
      driverPosition.latitude, driverPosition.longitude,
      target.lat, target.lng
    )

    const withinGeofence = distance <= GEOFENCE_RADIUS_MILES
    const remainingSeconds = Math.max(0, (distance / AVG_SPEED_MPH) * 3600)

    setState({
      remainingSeconds,
      formatted: formatETA(remainingSeconds),
      distanceMiles: Math.round(distance * 10) / 10,
      withinGeofence,
      geofenceTarget,
    })
  }, [load, driverPosition])

  // Recalculate every 30 seconds and on position change
  useEffect(() => {
    calculate()
    const interval = setInterval(calculate, 30000)
    return () => clearInterval(interval)
  }, [calculate])

  return state
}
