const CACHE_NAME = 'myra-driver-v2'
const STATIC_ASSETS = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png']
const GPS_STORE = 'gps-queue'
const GPS_DB = 'myra-driver-gps'

// IndexedDB helpers for GPS queue
function openGPSDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(GPS_DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(GPS_STORE, { autoIncrement: true })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function enqueueGPS(data) {
  const db = await openGPSDB()
  const tx = db.transaction(GPS_STORE, 'readwrite')
  tx.objectStore(GPS_STORE).add(data)
  return new Promise((resolve) => { tx.oncomplete = resolve })
}

async function drainGPSQueue() {
  const db = await openGPSDB()
  const tx = db.transaction(GPS_STORE, 'readwrite')
  const store = tx.objectStore(GPS_STORE)
  const all = await new Promise((resolve) => {
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result)
  })
  if (!all.length) return
  for (const item of all) {
    try {
      await fetch(item.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': item.auth },
        body: JSON.stringify(item.body),
      })
    } catch { break }
  }
  store.clear()
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Skip non-GET for caching (except GPS offline queue)
  if (request.method !== 'GET') return

  // Skip mapbox tiles
  if (url.hostname.includes('mapbox')) return

  // API: network-first
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    )
    return
  }

  // Static: cache-first
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((res) => {
      const clone = res.clone()
      caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
      return res
    }))
  )
})

// Background sync for GPS queue
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-gps') {
    event.waitUntil(drainGPSQueue())
  }
})

// Push notifications
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'Myra Driver', body: 'New notification' }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Myra Driver', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [200, 100, 200],
      data: data.url ? { url: data.url } : undefined,
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus()
      }
      return self.clients.openWindow(url)
    })
  )
})

// Listen for GPS updates from client
self.addEventListener('message', (event) => {
  if (event.data?.type === 'GPS_UPDATE') {
    enqueueGPS(event.data.payload)
  }
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
