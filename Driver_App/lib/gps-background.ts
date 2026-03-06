/**
 * Client-side GPS background tracking helper
 *
 * Registers for periodic background sync and handles GPS message relay
 * with the service worker. This module bridges the gap between the
 * Geolocation API (only available in window context) and the service
 * worker (which needs to POST positions even when the app is backgrounded).
 *
 * Usage:
 *   import { registerBackgroundGPS, stopBackgroundGPS } from '@/lib/gps-background'
 *
 *   // Start tracking when a driver begins a load
 *   await registerBackgroundGPS(loadId, authToken)
 *
 *   // Stop tracking when the load is delivered or driver goes off-duty
 *   stopBackgroundGPS()
 */

// Minimum interval for periodic background sync (in milliseconds).
// The browser may enforce a longer interval based on site engagement score.
const PERIODIC_SYNC_MIN_INTERVAL = 60 * 1000 // 1 minute

let activeWatchId: number | null = null
let messageHandler: ((event: MessageEvent) => void) | null = null
let activeLoadId: string | null = null
let activeToken: string | null = null

/**
 * Register for periodic background GPS sync and begin relaying
 * GPS positions to the service worker.
 *
 * @param loadId - The load ID the driver is currently hauling
 * @param token  - Auth token to include with GPS POSTs (SW cannot access localStorage)
 */
export async function registerBackgroundGPS(
  loadId: string,
  token: string
): Promise<void> {
  // Store active tracking context
  activeLoadId = loadId
  activeToken = token

  // 1. Register for periodic background sync (if supported)
  await registerPeriodicSync()

  // 2. Set up message listener for service worker GPS requests
  setupMessageRelay()

  // 3. Start watchPosition and proactively relay updates to the SW
  startWatchRelay()
}

/**
 * Stop all background GPS tracking:
 * - Unregister periodic sync
 * - Stop watchPosition
 * - Remove message listener
 */
export async function stopBackgroundGPS(): Promise<void> {
  // Stop the geolocation watch
  if (activeWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(activeWatchId)
    activeWatchId = null
  }

  // Remove the SW message relay handler
  if (messageHandler) {
    navigator.serviceWorker?.removeEventListener('message', messageHandler)
    messageHandler = null
  }

  // Unregister periodic background sync
  await unregisterPeriodicSync()

  // Clear tracking context
  activeLoadId = null
  activeToken = null
}

/**
 * Check whether periodic background sync is supported and register.
 * This is a progressive enhancement — on browsers without support,
 * the foreground watchPosition relay still works.
 */
async function registerPeriodicSync(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.ready
    if (!registration) return

    // TypeScript doesn't include periodicSync in the standard types yet
    const periodicSync = (registration as any).periodicSync
    if (!periodicSync) {
      console.log('[GPS Background] Periodic sync not supported — foreground relay only')
      return
    }

    // Check permission status
    const status = await navigator.permissions.query({
      name: 'periodic-background-sync' as PermissionName,
    })

    if (status.state === 'granted') {
      await periodicSync.register('gps-tracking', {
        minInterval: PERIODIC_SYNC_MIN_INTERVAL,
      })
      console.log('[GPS Background] Periodic sync registered')
    } else {
      console.log('[GPS Background] Periodic sync permission not granted:', status.state)
    }
  } catch (err) {
    console.warn('[GPS Background] Failed to register periodic sync:', err)
  }
}

/**
 * Unregister the periodic background sync tag.
 */
async function unregisterPeriodicSync(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.ready
    if (!registration) return

    const periodicSync = (registration as any).periodicSync
    if (!periodicSync) return

    await periodicSync.unregister('gps-tracking')
    console.log('[GPS Background] Periodic sync unregistered')
  } catch (err) {
    console.warn('[GPS Background] Failed to unregister periodic sync:', err)
  }
}

/**
 * Listen for REQUEST_GPS messages from the service worker.
 * When the SW fires a periodic sync, it asks the client for coordinates
 * because navigator.geolocation is not available in SW context.
 */
function setupMessageRelay(): void {
  if (!navigator.serviceWorker) return

  // Remove any existing handler to avoid duplicates
  if (messageHandler) {
    navigator.serviceWorker.removeEventListener('message', messageHandler)
  }

  messageHandler = (event: MessageEvent) => {
    if (event.data?.type === 'REQUEST_GPS') {
      // Respond with a one-shot GPS reading
      navigator.geolocation.getCurrentPosition(
        (position) => {
          sendPositionToSW({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            speed: position.coords.speed,
            heading: position.coords.heading,
          })
        },
        (err) => {
          console.warn('[GPS Background] Failed to get position for SW request:', err.message)
        },
        {
          enableHighAccuracy: true,
          maximumAge: 30000,
          timeout: 10000,
        }
      )
    }
  }

  navigator.serviceWorker.addEventListener('message', messageHandler)
}

/**
 * Start the geolocation watchPosition and proactively relay every
 * position update to the service worker via postMessage. This is the
 * primary tracking path when the app is in the foreground.
 */
function startWatchRelay(): void {
  if (!navigator.geolocation) {
    console.error('[GPS Background] Geolocation API not available')
    return
  }

  // Clear any previous watch
  if (activeWatchId !== null) {
    navigator.geolocation.clearWatch(activeWatchId)
  }

  activeWatchId = navigator.geolocation.watchPosition(
    (position) => {
      sendPositionToSW({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        speed: position.coords.speed,
        heading: position.coords.heading,
      })
    },
    (err) => {
      console.warn('[GPS Background] Watch position error:', err.message)
    },
    {
      enableHighAccuracy: true,
      maximumAge: 30000,
      timeout: 15000,
    }
  )
}

/**
 * Send a GPS position to the service worker via postMessage.
 * The SW will POST it to the tracking API (or queue it for sync if offline).
 */
function sendPositionToSW(coords: {
  latitude: number
  longitude: number
  speed: number | null
  heading: number | null
}): void {
  if (!activeLoadId) return

  navigator.serviceWorker?.controller?.postMessage({
    type: 'GPS_UPDATE',
    payload: {
      loadId: activeLoadId,
      token: activeToken,
      latitude: coords.latitude,
      longitude: coords.longitude,
      speed: coords.speed,
      heading: coords.heading,
    },
  })
}
