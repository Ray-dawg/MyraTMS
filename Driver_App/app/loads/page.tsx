'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Truck, RefreshCw, LogOut, PackageOpen, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/use-auth'
import { driverFetch } from '@/lib/api'
import { LoadCard } from '@/components/load-card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

interface Load {
  id: string
  origin: string
  destination: string
  status: string
  pickup_date: string | null
  delivery_date: string | null
  equipment: string
  weight: string
  shipper_name: string
  carrier_name: string
}

export default function LoadsPage() {
  const { authenticated, driver, loading: authLoading, logout, requireAuth } = useAuth()
  const [loads, setLoads] = useState<Load[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchLoads = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true)
    else setLoading(true)

    try {
      const res = await driverFetch('/api/drivers/me/loads')
      if (res.ok) {
        const data = await res.json()
        setLoads(data)
      } else {
        toast.error('Failed to load assignments')
      }
    } catch {
      toast.error('Network error. Check your connection.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    requireAuth()
  }, [requireAuth])

  useEffect(() => {
    if (authenticated) {
      fetchLoads()
    }
  }, [authenticated, fetchLoads])

  // Pull-to-refresh handler
  useEffect(() => {
    let touchStartY = 0
    let pulling = false

    function handleTouchStart(e: TouchEvent) {
      if (window.scrollY === 0) {
        touchStartY = e.touches[0].clientY
        pulling = true
      }
    }

    function handleTouchEnd(e: TouchEvent) {
      if (pulling && e.changedTouches[0].clientY - touchStartY > 80) {
        fetchLoads(true)
      }
      pulling = false
    }

    document.addEventListener('touchstart', handleTouchStart, { passive: true })
    document.addEventListener('touchend', handleTouchEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', handleTouchStart)
      document.removeEventListener('touchend', handleTouchEnd)
    }
  }, [fetchLoads])

  if (authLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="flex min-h-svh flex-col bg-background">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur-sm">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary">
              <Truck className="size-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-base font-semibold">My Loads</h1>
              {driver && (
                <p className="text-xs text-muted-foreground">
                  {driver.firstName} {driver.lastName}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => fetchLoads(true)}
              disabled={refreshing}
            >
              <RefreshCw className={`size-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={logout}>
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 px-4 py-4">
        {loading ? (
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-36 w-full rounded-xl" />
            ))}
          </div>
        ) : loads.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 pt-20 text-center">
            <div className="flex size-16 items-center justify-center rounded-full bg-muted">
              <PackageOpen className="size-8 text-muted-foreground" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">No Active Loads</h2>
              <p className="text-sm text-muted-foreground mt-1">
                You don't have any assigned loads right now.
                <br />
                Pull down to refresh.
              </p>
            </div>
            <Button variant="outline" onClick={() => fetchLoads(true)}>
              <RefreshCw className="size-4" />
              Refresh
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {loads.length} active load{loads.length !== 1 ? 's' : ''}
            </p>
            {loads.map((load) => (
              <LoadCard key={load.id} load={load} />
            ))}
          </div>
        )}
      </main>

      {/* Bottom navigation */}
      <nav className="sticky bottom-0 border-t bg-background/95 backdrop-blur-sm safe-area-bottom">
        <div className="flex items-center justify-around py-2">
          <button className="flex flex-col items-center gap-0.5 px-4 py-1 text-primary touch-target">
            <Truck className="size-5" />
            <span className="text-[10px] font-medium">Loads</span>
          </button>
        </div>
      </nav>
    </div>
  )
}
