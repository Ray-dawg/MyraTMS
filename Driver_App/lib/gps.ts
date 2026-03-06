export interface GPSPosition {
  latitude: number
  longitude: number
  speed: number | null // m/s
  heading: number | null
  accuracy: number
  timestamp: number
}

export function startGPSTracking(
  loadId: string,
  onPosition: (pos: GPSPosition) => void,
  onError?: (error: GeolocationPositionError) => void
): number {
  if (!navigator.geolocation) {
    throw new Error('Geolocation is not supported by this browser')
  }

  const watchId = navigator.geolocation.watchPosition(
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
    (error) => {
      console.error(`GPS error for load ${loadId}:`, error.message)
      if (onError) onError(error)
    },
    {
      enableHighAccuracy: true,
      maximumAge: 30000,
      timeout: 15000,
    }
  )

  return watchId
}

export function stopGPSTracking(watchId: number): void {
  navigator.geolocation.clearWatch(watchId)
}

/**
 * Convert speed from m/s to mph
 */
export function speedToMph(speedMs: number | null): number {
  if (speedMs === null || speedMs < 0) return 0
  return Math.round(speedMs * 2.237)
}

/**
 * Request GPS permission explicitly
 */
export async function requestGPSPermission(): Promise<PermissionState> {
  try {
    const result = await navigator.permissions.query({ name: 'geolocation' })
    return result.state
  } catch {
    // Fallback: try to get a position to trigger the permission dialog
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        () => resolve('granted'),
        (err) => {
          if (err.code === err.PERMISSION_DENIED) resolve('denied')
          else resolve('prompt')
        },
        { timeout: 5000 }
      )
    })
  }
}
