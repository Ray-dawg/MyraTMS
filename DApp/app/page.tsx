'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { BottomNav } from '@/components/bottom-nav'
import type { Screen } from '@/components/bottom-nav'
import { MapScreen } from '@/components/map-screen'
import { LoadDetailsScreen } from '@/components/load-details-screen'
import { LoadsListScreen } from '@/components/loads-list-screen'
import { DocsScreen } from '@/components/docs-screen'
import { ProfileScreen } from '@/components/profile-screen'
import { FABMenu } from '@/components/fab-menu'
import { ETAPill, GeofencePrompt } from '@/components/eta-pill'
import { RequestLoad } from '@/components/request-load'
import { useServiceWorker } from '@/hooks/use-service-worker'
import { useAuth } from '@/hooks/use-auth'
import { useGPS } from '@/hooks/use-gps'
import { useETA } from '@/hooks/use-eta'
import { driverFetch } from '@/lib/driver-fetch'
import { hapticLight, hapticMedium, hapticSuccess, hapticHeavy } from '@/lib/haptics'
import { mockLoads, mapApiLoad } from '@/lib/mock-data'
import type { Load, LoadStatus } from '@/lib/mock-data'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// Map internal status to next status for geofence auto-prompt
const geofenceStatusMap: Partial<Record<string, { status: LoadStatus; target: 'pickup' | 'delivery' }>> = {
  en_route_pickup: { status: 'at_pickup', target: 'pickup' },
  en_route_delivery: { status: 'at_delivery', target: 'delivery' },
}

export default function DriverApp() {
  useServiceWorker()
  const router = useRouter()
  const { authenticated, loading: authLoading, logout } = useAuth()

  const [screen, setScreen] = useState<Screen>('map')
  const [loads, setLoads] = useState<Load[]>([])
  const [selectedLoad, setSelectedLoad] = useState<Load | undefined>(undefined)
  const [dataLoading, setDataLoading] = useState(true)
  const [immersive, setImmersive] = useState(false)
  const [navHidden, setNavHidden] = useState(false)
  const [screenTransition, setScreenTransition] = useState(false)
  const [geofenceDismissed, setGeofenceDismissed] = useState(false)
  const [showGeofencePrompt, setShowGeofencePrompt] = useState(false)

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !authenticated) router.push('/login')
  }, [authLoading, authenticated, router])

  // Fetch loads from API
  const fetchLoads = useCallback(async () => {
    setDataLoading(true)
    try {
      const res = await driverFetch('/api/drivers/me/loads')
      if (res.ok) {
        const data = await res.json()
        const rows = Array.isArray(data) ? data : data.loads || []
        const mapped = rows.map(mapApiLoad)
        setLoads(mapped.length > 0 ? mapped : mockLoads)
      } else {
        setLoads(mockLoads)
      }
    } catch {
      setLoads(mockLoads)
    } finally {
      setDataLoading(false)
    }
  }, [])

  useEffect(() => {
    if (authenticated) fetchLoads()
  }, [authenticated, fetchLoads])

  const activeLoad = loads.find((l) => !['delivered', 'completed'].includes(l.status))

  // GPS tracking for active load
  const gpsEnabled = !!activeLoad && ['en_route_pickup', 'at_pickup', 'loaded', 'en_route_delivery', 'at_delivery'].includes(activeLoad.status)
  const gps = useGPS({ loadId: activeLoad?.id || '', enabled: gpsEnabled })

  // ETA calculation
  const eta = useETA(activeLoad, gps.position)

  // Geofence detection — auto-prompt when driver enters geofence
  useEffect(() => {
    if (eta.withinGeofence && !geofenceDismissed && activeLoad) {
      const mapping = geofenceStatusMap[activeLoad.status]
      if (mapping) {
        hapticHeavy()
        setShowGeofencePrompt(true)
      }
    } else if (!eta.withinGeofence) {
      setGeofenceDismissed(false)
      setShowGeofencePrompt(false)
    }
  }, [eta.withinGeofence, geofenceDismissed, activeLoad])

  // Screen transitions with animation
  const handleNavigate = useCallback((s: Screen) => {
    hapticLight()
    setScreenTransition(true)
    if (s !== 'map') setImmersive(false)
    requestAnimationFrame(() => {
      setScreen(s)
      setTimeout(() => setScreenTransition(false), 300)
    })
  }, [])

  const handleViewDetails = useCallback(() => {
    hapticLight()
    if (activeLoad) setSelectedLoad(activeLoad)
    setImmersive(false)
    setScreenTransition(true)
    setScreen('active')
    setTimeout(() => setScreenTransition(false), 300)
  }, [activeLoad])

  const handleSelectLoad = useCallback((load: Load) => {
    hapticLight()
    setSelectedLoad(load)
    setImmersive(false)
    setScreen('active')
  }, [])

  const handleBackFromDetails = useCallback(() => {
    hapticLight()
    setScreen('map')
  }, [])

  const handleToggleImmersive = useCallback(() => {
    hapticMedium()
    setImmersive((prev) => {
      if (!prev) setNavHidden(true)
      return !prev
    })
  }, [])

  const handleToggleNav = useCallback(() => {
    hapticLight()
    setNavHidden((prev) => !prev)
  }, [])

  const handleStatusUpdate = useCallback(async (loadId: string, newStatus: LoadStatus) => {
    hapticSuccess()
    setShowGeofencePrompt(false)
    setGeofenceDismissed(false)

    // Optimistic update
    setLoads((prev) => prev.map((l) => l.id === loadId ? { ...l, status: newStatus, updatedAt: new Date().toISOString() } : l))
    setSelectedLoad((prev) => prev && prev.id === loadId ? { ...prev, status: newStatus } : prev)

    // Map DApp status to TMS API status
    const statusMap: Partial<Record<LoadStatus, string>> = {
      en_route_pickup: 'Dispatched',
      en_route_delivery: 'In Transit',
      delivered: 'Delivered',
    }
    const apiStatus = statusMap[newStatus]
    if (apiStatus) {
      try {
        await driverFetch(`/api/loads/${loadId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: apiStatus }),
        })
      } catch { /* optimistic update already applied */ }
    }
  }, [])

  const handleGeofenceConfirm = useCallback(() => {
    if (!activeLoad) return
    const mapping = geofenceStatusMap[activeLoad.status]
    if (mapping) {
      handleStatusUpdate(activeLoad.id, mapping.status)
    }
  }, [activeLoad, handleStatusUpdate])

  const handleGeofenceDismiss = useCallback(() => {
    hapticLight()
    setShowGeofencePrompt(false)
    setGeofenceDismissed(true)
  }, [])

  const handleCapturePhoto = useCallback(() => {
    if (activeLoad) {
      setSelectedLoad(activeLoad)
      setScreen('active')
      setImmersive(false)
    }
  }, [activeLoad])

  const handleLoadAccepted = useCallback(() => {
    fetchLoads()
    setScreen('map')
  }, [fetchLoads])

  // Auth loading state
  if (authLoading) {
    return (
      <main className="flex h-dvh items-center justify-center bg-background">
        <Loader2 className="size-8 animate-spin text-primary" />
      </main>
    )
  }

  if (!authenticated) return null

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-background">
      {/* Map screen - always mounted for performance */}
      <div
        className={screen === 'map' ? 'h-full' : 'pointer-events-none fixed inset-0 opacity-0'}
        aria-hidden={screen !== 'map'}
      >
        <MapScreen
          activeLoad={activeLoad}
          onViewDetails={handleViewDetails}
          driverPosition={gps.position}
          immersive={immersive}
          onToggleImmersive={handleToggleImmersive}
        />
      </div>

      {screen === 'active' && (
        <div className={cn(
          'h-full',
          screenTransition && 'animate-in fade-in slide-in-from-right-4 duration-300'
        )}>
          <LoadDetailsScreen load={selectedLoad || activeLoad} onBack={handleBackFromDetails} onStatusUpdate={handleStatusUpdate} />
        </div>
      )}

      {screen === 'loads' && (
        <div className={cn(
          'h-full',
          screenTransition && 'animate-in fade-in slide-in-from-bottom-4 duration-300'
        )}>
          <LoadsListScreen loads={loads} onSelectLoad={handleSelectLoad} />
        </div>
      )}

      {screen === 'docs' && (
        <div className={cn(
          'h-full',
          screenTransition && 'animate-in fade-in slide-in-from-bottom-4 duration-300'
        )}>
          <DocsScreen />
        </div>
      )}

      {screen === 'profile' && (
        <div className={cn(
          'h-full',
          screenTransition && 'animate-in fade-in slide-in-from-bottom-4 duration-300'
        )}>
          <ProfileScreen onLogout={logout} />
        </div>
      )}

      {/* ETA Countdown Pill — floating on map screen */}
      {screen === 'map' && activeLoad && !immersive && (
        <ETAPill
          formatted={eta.formatted}
          distanceMiles={eta.distanceMiles}
          geofenceTarget={eta.geofenceTarget}
          className="absolute top-14 left-1/2 z-20 -translate-x-1/2"
        />
      )}

      {/* Geofence arrival prompt */}
      {showGeofencePrompt && activeLoad && eta.geofenceTarget && (
        <div className="absolute bottom-36 left-0 right-0 z-30">
          <GeofencePrompt
            target={eta.geofenceTarget}
            onConfirm={handleGeofenceConfirm}
            onDismiss={handleGeofenceDismiss}
          />
        </div>
      )}

      {/* Request Load — shown on map when no active load */}
      {screen === 'map' && !activeLoad && !dataLoading && (
        <div className="absolute inset-x-0 bottom-20 z-10 max-h-[70vh] overflow-y-auto rounded-t-2xl border-t border-border bg-card/95 backdrop-blur-md">
          <RequestLoad
            onLoadAccepted={handleLoadAccepted}
            driverPosition={gps.position}
          />
        </div>
      )}

      {/* Quick Actions FAB — visible on map and active screens */}
      {(screen === 'map' || screen === 'active') && activeLoad && (
        <FABMenu
          activeLoad={activeLoad}
          onCapturePhoto={handleCapturePhoto}
          className={cn(
            'transition-all duration-500',
            navHidden && 'bottom-6'
          )}
        />
      )}

      <BottomNav
        active={screen}
        onNavigate={handleNavigate}
        hasActiveLoad={!!activeLoad}
        hidden={navHidden}
        onToggleHidden={handleToggleNav}
      />
    </main>
  )
}
