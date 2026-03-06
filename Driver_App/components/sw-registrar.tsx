'use client'

import { useEffect, useState, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'

export function ServiceWorkerRegistrar() {
  const [updateAvailable, setUpdateAvailable] = useState(false)

  const handleUpdate = useCallback(() => {
    window.location.reload()
  }, [])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    navigator.serviceWorker.register('/sw.js').then((registration) => {
      // Listen for new service worker installing
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing
        if (!newWorker) return

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'activated') {
            setUpdateAvailable(true)
          }
        })
      })

      // Poll for updates every 60s
      const interval = setInterval(() => {
        registration.update().catch(() => {})
      }, 60_000)

      return () => clearInterval(interval)
    }).catch((err) => {
      console.log('SW registration failed:', err)
    })

    // Listen for SW messages
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SW_UPDATED') {
        setUpdateAvailable(true)
      }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])

  if (!updateAvailable) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontFamily: "-apple-system, 'SF Pro Display', BlinkMacSystemFont, 'Inter', sans-serif",
        boxShadow: '0 4px 16px rgba(59,130,246,0.3)',
      }}
    >
      <span style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>
        Update available
      </span>
      <button
        onClick={handleUpdate}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 14px',
          borderRadius: 8,
          background: 'rgba(255,255,255,0.2)',
          border: '1px solid rgba(255,255,255,0.3)',
          color: '#fff',
          fontSize: 12,
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        <RefreshCw size={12} />
        Refresh
      </button>
    </div>
  )
}
