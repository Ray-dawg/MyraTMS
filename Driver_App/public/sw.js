const CACHE_NAME = 'myra-driver-v2'
const STATIC_ASSETS = [
  '/',
  '/dashboard',
  '/login',
  '/offline',
  '/manifest.json',
  '/myra-logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

// ---------------------------------------------------------------------------
// IndexedDB helpers for GPS queue (offline resilience)
// ---------------------------------------------------------------------------
const GPS_DB_NAME = 'myra-driver-gps'
const GPS_DB_VERSION = 1
const GPS_STORE_NAME = 'gps-queue'

function openGPSDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(GPS_DB_NAME, GPS_DB_VERSION)
    request.onupgradeneeded = (event) => {
      const db = event.target.result
      if (!db.objectStoreNames.contains(GPS_STORE_NAME)) {
        db.createObjectStore(GPS_STORE_NAME, { keyPath: 'id', autoIncrement: true })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function enqueueGPSData(data) {
  try {
    const db = await openGPSDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(GPS_STORE_NAME, 'readwrite')
      const store = tx.objectStore(GPS_STORE_NAME)
      store.add({ ...data, queuedAt: new Date().toISOString() })
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    })
  } catch (err) {
    console.error('[SW] Failed to enqueue GPS data:', err)
  }
}

async function drainGPSQueue() {
  try {
    const db = await openGPSDatabase()
    const items = await new Promise((resolve, reject) => {
      const tx = db.transaction(GPS_STORE_NAME, 'readonly')
      const store = tx.objectStore(GPS_STORE_NAME)
      const request = store.getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      tx.oncomplete = () => {} // no-op, just let it finish
    })

    if (!items || items.length === 0) {
      db.close()
      return
    }

    // Attempt to send each queued item
    const successIds = []
    for (const item of items) {
      try {
        const response = await fetch('/api/tracking/positions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(item.token ? { 'Authorization': `Bearer ${item.token}` } : {}),
          },
          body: JSON.stringify({
            load_id: item.loadId,
            latitude: item.latitude,
            longitude: item.longitude,
            speed: item.speed,
            heading: item.heading,
            timestamp: item.timestamp,
          }),
        })
        if (response.ok) {
          successIds.push(item.id)
        }
      } catch {
        // Still offline for this item, leave it in the queue
      }
    }

    // Remove successfully sent items
    if (successIds.length > 0) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(GPS_STORE_NAME, 'readwrite')
        const store = tx.objectStore(GPS_STORE_NAME)
        successIds.forEach((id) => store.delete(id))
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    }

    db.close()
  } catch (err) {
    console.error('[SW] Failed to drain GPS queue:', err)
  }
}

// ---------------------------------------------------------------------------
// GPS position sender — POST coordinates to the tracking API
// ---------------------------------------------------------------------------
async function sendGPSToServer(data) {
  try {
    const response = await fetch('/api/tracking/positions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(data.token ? { 'Authorization': `Bearer ${data.token}` } : {}),
      },
      body: JSON.stringify({
        load_id: data.loadId,
        latitude: data.latitude,
        longitude: data.longitude,
        speed: data.speed,
        heading: data.heading,
        timestamp: new Date().toISOString(),
      }),
    })

    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}`)
    }

    console.log('[SW] GPS position sent successfully')
  } catch (err) {
    console.warn('[SW] GPS send failed, queuing for background sync:', err.message)
    // Queue the data in IndexedDB for later sync
    await enqueueGPSData(data)
    // Request a one-off background sync to retry later
    if (self.registration && self.registration.sync) {
      try {
        await self.registration.sync.register('sync-gps')
      } catch {
        console.warn('[SW] Background sync registration failed')
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Periodic sync handler — request GPS from open clients
// navigator.geolocation is NOT available in service workers, so we relay
// through any visible client page that can access the Geolocation API.
// ---------------------------------------------------------------------------
async function sendGPSPosition() {
  try {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: false })

    if (clients.length === 0) {
      console.log('[SW] No open clients — skipping periodic GPS update')
      return
    }

    // Ask the first visible client to send us its GPS coordinates
    clients.forEach((client) => {
      client.postMessage({ type: 'REQUEST_GPS' })
    })
  } catch (err) {
    console.error('[SW] Periodic GPS sync error:', err)
  }
}

// Install: pre-cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        console.log('[SW] Some static assets could not be pre-cached')
      })
    })
  )
  self.skipWaiting()
})

// Activate: clean old caches + notify clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => {
      // Notify all clients that SW has been updated
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'SW_UPDATED', version: CACHE_NAME })
        })
      })
    })
  )
  self.clients.claim()
})

// Fetch: network-first for API, cache-first for static
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Skip non-GET requests
  if (request.method !== 'GET') return

  // API calls: network-first, fallback to cache
  if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
          }
          return response
        })
        .catch(() => caches.match(request))
    )
    return
  }

  // Static assets: cache-first, fallback to network
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
        }
        return response
      })
    }).catch(() => {
      // Offline fallback for navigation requests
      if (request.mode === 'navigate') {
        return caches.match('/offline')
      }
    })
  )
})

// ---------------------------------------------------------------------------
// Background sync — drain queued GPS data when connectivity is restored
// ---------------------------------------------------------------------------
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-gps') {
    event.waitUntil(drainGPSQueue())
  }
  if (event.tag === 'sync-status-updates') {
    event.waitUntil(Promise.resolve())
  }
})

// ---------------------------------------------------------------------------
// Periodic background sync — track GPS at regular intervals even when
// the app is minimized/backgrounded (requires browser support)
// ---------------------------------------------------------------------------
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'gps-tracking') {
    event.waitUntil(sendGPSPosition())
  }
})

// ---------------------------------------------------------------------------
// Push notifications — display incoming push messages
// ---------------------------------------------------------------------------
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {}
  const title = data.title || 'Myra Driver'
  const options = {
    body: data.body || 'You have a new notification',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: data.data || {},
    vibrate: [200, 100, 200],
    actions: data.actions || []
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const url = data.url || '/dashboard'
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(url) && 'focus' in client) {
          return client.focus()
        }
      }
      return clients.openWindow(url)
    })
  )
})

// ---------------------------------------------------------------------------
// Message handler — receive GPS data relayed from client pages
// ---------------------------------------------------------------------------
self.addEventListener('message', (event) => {
  if (!event.data) return

  // Client is sending a GPS update (either proactively or in response to REQUEST_GPS)
  if (event.data.type === 'GPS_UPDATE') {
    // event.data.payload = { latitude, longitude, speed, heading, loadId, token }
    const payload = event.data.payload
    if (payload && payload.latitude != null && payload.longitude != null) {
      sendGPSToServer(payload)
    }
  }

  // Skip waiting — used during SW update flow
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
