'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { startGPSTracking, stopGPSTracking, speedToMph, type GPSPosition } from '@/lib/gps'
import { driverFetch } from '@/lib/driver-fetch'

interface UseGPSOptions {
  loadId: string
  enabled?: boolean
  reportIntervalMs?: number
}

interface GPSState {
  status: 'inactive' | 'active' | 'error' | 'denied'
  position: GPSPosition | null
  speedMph: number
  lastReportedAt: Date | null
  error: string | null
}

export function useGPS({ loadId, enabled = false, reportIntervalMs = 30000 }: UseGPSOptions) {
  const [state, setState] = useState<GPSState>({
    status: 'inactive', position: null, speedMph: 0, lastReportedAt: null, error: null,
  })
  const watchIdRef = useRef<number | null>(null)
  const lastReportRef = useRef<number>(0)

  const reportPosition = useCallback(async (pos: GPSPosition) => {
    const now = Date.now()
    if (now - lastReportRef.current < reportIntervalMs) return
    lastReportRef.current = now
    try {
      await driverFetch(`/api/loads/${loadId}/location`, {
        method: 'POST',
        body: JSON.stringify({ lat: pos.latitude, lng: pos.longitude, speed: pos.speed, heading: pos.heading }),
      })
      setState((prev) => ({ ...prev, lastReportedAt: new Date() }))
    } catch { /* silent */ }
  }, [loadId, reportIntervalMs])

  const handlePosition = useCallback((pos: GPSPosition) => {
    setState((prev) => ({ ...prev, status: 'active', position: pos, speedMph: speedToMph(pos.speed), error: null }))
    reportPosition(pos)
  }, [reportPosition])

  const handleError = useCallback((error: GeolocationPositionError) => {
    setState((prev) => ({
      ...prev,
      status: error.code === error.PERMISSION_DENIED ? 'denied' : 'error',
      error: error.message,
    }))
  }, [])

  const start = useCallback(() => {
    if (watchIdRef.current !== null) return
    try {
      watchIdRef.current = startGPSTracking(loadId, handlePosition, handleError)
      setState((prev) => ({ ...prev, status: 'active', error: null }))
    } catch (error) {
      setState((prev) => ({ ...prev, status: 'error', error: error instanceof Error ? error.message : 'Failed' }))
    }
  }, [loadId, handlePosition, handleError])

  const stop = useCallback(() => {
    if (watchIdRef.current !== null) {
      stopGPSTracking(watchIdRef.current)
      watchIdRef.current = null
    }
    setState((prev) => ({ ...prev, status: 'inactive' }))
  }, [])

  useEffect(() => {
    if (enabled) start(); else stop()
    return () => { if (watchIdRef.current !== null) { stopGPSTracking(watchIdRef.current); watchIdRef.current = null } }
  }, [enabled, start, stop])

  return { ...state, start, stop }
}
