export interface GPSPosition {
  latitude: number
  longitude: number
  speed: number | null
  heading: number | null
  accuracy: number
  timestamp: number
}

export function startGPSTracking(
  _loadId: string,
  onPosition: (pos: GPSPosition) => void,
  onError?: (error: GeolocationPositionError) => void
): number {
  if (!navigator.geolocation) throw new Error('Geolocation not supported')

  return navigator.geolocation.watchPosition(
    (position) => {
      onPosition({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        speed: position.coords.speed,
        heading: position.coords.heading,
        accuracy: position.coords.accuracy,
        timestamp: position.timestamp,
      })
    },
    (error) => { if (onError) onError(error) },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 }
  )
}

export function stopGPSTracking(watchId: number): void {
  navigator.geolocation.clearWatch(watchId)
}

export function speedToMph(speedMs: number | null): number {
  if (speedMs === null || speedMs < 0) return 0
  return Math.round(speedMs * 2.237)
}
