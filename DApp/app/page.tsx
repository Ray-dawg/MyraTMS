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
import { useServiceWorker } from '@/hooks/use-service-worker'
import { useAuth } from '@/hooks/use-auth'
import { useGPS } from '@/hooks/use-gps'
import { driverFetch } from '@/lib/driver-fetch'
import { mockLoads, mapApiLoad } from '@/lib/mock-data'
import type { Load, LoadStatus } from '@/lib/mock-data'
import { Loader2 } from 'lucide-react'

export default function DriverApp() {
  useServiceWorker()
  const router = useRouter()
  const { authenticated, loading: authLoading, logout } = useAuth()

  const [screen, setScreen] = useState<Screen>('map')
  const [loads, setLoads] = useState<Load[]>([])
  const [selectedLoad, setSelectedLoad] = useState<Load | undefined>(undefined)
  const [dataLoading, setDataLoading] = useState(true)

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

  const handleNavigate = useCallback((s: Screen) => { setScreen(s) }, [])

  const handleViewDetails = useCallback(() => {
    if (activeLoad) setSelectedLoad(activeLoad)
    setScreen('active')
  }, [activeLoad])

  const handleSelectLoad = useCallback((load: Load) => {
    setSelectedLoad(load)
    setScreen('active')
  }, [])

  const handleBackFromDetails = useCallback(() => { setScreen('map') }, [])

  const handleStatusUpdate = useCallback(async (loadId: string, newStatus: LoadStatus) => {
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
        <MapScreen activeLoad={activeLoad} onViewDetails={handleViewDetails} driverPosition={gps.position} />
      </div>

      {screen === 'active' && (
        <div className="h-full">
          <LoadDetailsScreen load={selectedLoad || activeLoad} onBack={handleBackFromDetails} onStatusUpdate={handleStatusUpdate} />
        </div>
      )}

      {screen === 'loads' && (
        <div className="h-full">
          <LoadsListScreen loads={loads} onSelectLoad={handleSelectLoad} />
        </div>
      )}

      {screen === 'docs' && (
        <div className="h-full">
          <DocsScreen />
        </div>
      )}

      {screen === 'profile' && (
        <div className="h-full">
          <ProfileScreen onLogout={logout} />
        </div>
      )}

      <BottomNav active={screen} onNavigate={handleNavigate} hasActiveLoad={!!activeLoad} />
    </main>
  )
}
