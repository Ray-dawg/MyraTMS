'use client'

import { useState, useCallback } from 'react'
import {
  Search,
  Loader2,
  MapPin,
  Calendar,
  Truck,
  DollarSign,
  CheckCircle2,
  AlertCircle,
  Navigation,
  Package,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { driverFetch, getDriverInfo } from '@/lib/driver-fetch'
import { hapticLight, hapticMedium, hapticSuccess, hapticError } from '@/lib/haptics'

interface AvailableLoad {
  id: string
  origin: string
  destination: string
  equipment: string
  weight: number
  revenue: number
  carrierCost: number
  pickupDate: string
  deliveryDate: string
  shipperName: string
  distanceMiles: number
}

interface RequestLoadProps {
  onLoadAccepted?: (loadId: string) => void
  driverPosition?: { latitude: number; longitude: number } | null
}

type RequestState = 'idle' | 'searching' | 'results' | 'no_matches' | 'accepted' | 'error'

export function RequestLoad({ onLoadAccepted, driverPosition }: RequestLoadProps) {
  const [state, setState] = useState<RequestState>('idle')
  const [loads, setLoads] = useState<AvailableLoad[]>([])
  const [message, setMessage] = useState('')
  const [acceptingId, setAcceptingId] = useState<string | null>(null)

  const requestLoads = useCallback(async () => {
    hapticMedium()
    setState('searching')
    setMessage('')

    try {
      const driverInfo = getDriverInfo()
      const res = await driverFetch('/api/loads/request', {
        method: 'POST',
        body: JSON.stringify({
          driverId: driverInfo?.id || 'unknown',
          driverName: driverInfo ? `${driverInfo.firstName} ${driverInfo.lastName}` : 'Driver',
          carrierId: driverInfo?.carrierId || '',
          carrierName: driverInfo?.carrierName || '',
          lat: driverPosition?.latitude || null,
          lng: driverPosition?.longitude || null,
          equipment: 'Dry Van',
          maxRadius: 200,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        if (data.status === 'matches_found') {
          hapticSuccess()
          setLoads(data.loads)
          setState('results')
          setMessage(data.message)
        } else {
          hapticLight()
          setLoads([])
          setState('no_matches')
          setMessage(data.message)
        }
      } else {
        throw new Error('Request failed')
      }
    } catch {
      hapticError()
      setState('error')
      setMessage('Could not reach dispatch. Check your connection and try again.')
    }
  }, [driverPosition])

  const acceptLoad = useCallback(async (loadId: string) => {
    hapticMedium()
    setAcceptingId(loadId)

    try {
      const driverInfo = getDriverInfo()
      const res = await driverFetch(`/api/loads/${loadId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          carrier_id: driverInfo?.carrierId,
          carrier_name: driverInfo?.carrierName,
          status: 'Dispatched',
        }),
      })

      if (res.ok) {
        hapticSuccess()
        setState('accepted')
        setMessage(`Load ${loadId} accepted! Refreshing...`)
        setTimeout(() => onLoadAccepted?.(loadId), 1500)
      } else {
        hapticError()
        setMessage('Failed to accept load. It may have been taken.')
        // Remove from list
        setLoads((prev) => prev.filter((l) => l.id !== loadId))
      }
    } catch {
      hapticError()
      setMessage('Connection error. Try again.')
    } finally {
      setAcceptingId(null)
    }
  }, [onLoadAccepted])

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '--'
    return new Date(dateStr).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
  }

  // Idle state — show request button
  if (state === 'idle' || state === 'error') {
    return (
      <div className="flex flex-col items-center px-6 py-8 text-center">
        <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-primary/10">
          <Search className="size-8 text-primary" />
        </div>
        <h2 className="text-lg font-bold text-foreground">Need a Load?</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-[260px]">
          We'll find available loads near you matched to your equipment and lanes.
        </p>
        {state === 'error' && message && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2">
            <AlertCircle className="size-4 text-destructive shrink-0" />
            <p className="text-xs text-foreground">{message}</p>
          </div>
        )}
        <button
          onClick={requestLoads}
          className="mt-6 flex items-center gap-2 rounded-xl bg-primary px-8 py-3.5 text-sm font-bold text-primary-foreground shadow-lg transition-all active:scale-95"
        >
          <Search className="size-4" />
          Find Available Loads
        </button>
      </div>
    )
  }

  // Searching
  if (state === 'searching') {
    return (
      <div className="flex flex-col items-center px-6 py-12 text-center">
        <div className="relative mb-4">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10">
            <Loader2 className="size-8 text-primary animate-spin" />
          </div>
          <span className="absolute -top-1 -right-1 flex size-5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/40" />
            <span className="relative inline-flex size-5 rounded-full bg-primary" />
          </span>
        </div>
        <h2 className="text-lg font-bold text-foreground">Searching...</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Scanning loads within 200 miles of your location
        </p>
      </div>
    )
  }

  // No matches — dispatch notified
  if (state === 'no_matches') {
    return (
      <div className="flex flex-col items-center px-6 py-8 text-center">
        <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-accent/10">
          <AlertCircle className="size-8 text-accent" />
        </div>
        <h2 className="text-lg font-bold text-foreground">Dispatch Notified</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-[260px]">
          {message}
        </p>
        <button
          onClick={() => { hapticLight(); setState('idle') }}
          className="mt-6 rounded-lg bg-secondary px-6 py-2.5 text-sm font-semibold text-foreground transition-all active:scale-95"
        >
          Try Again Later
        </button>
      </div>
    )
  }

  // Accepted
  if (state === 'accepted') {
    return (
      <div className="flex flex-col items-center px-6 py-12 text-center animate-in zoom-in duration-300">
        <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-success/10">
          <CheckCircle2 className="size-8 text-success" />
        </div>
        <h2 className="text-lg font-bold text-foreground">Load Accepted!</h2>
        <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      </div>
    )
  }

  // Results — show load cards
  return (
    <div className="px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-foreground">Available Loads</h2>
          <p className="text-xs text-muted-foreground">{message}</p>
        </div>
        <button
          onClick={() => { hapticLight(); setState('idle') }}
          className="rounded-md bg-secondary px-3 py-1.5 text-[11px] font-medium text-foreground transition-all active:scale-95"
        >
          Refresh
        </button>
      </div>

      <div className="space-y-3">
        {loads.map((load) => (
          <div
            key={load.id}
            className="rounded-xl border border-border bg-card p-4 transition-all animate-in fade-in slide-in-from-bottom-2 duration-300"
          >
            {/* Route */}
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <MapPin className="size-3.5 text-accent shrink-0" />
                  <span className="text-sm font-semibold text-foreground">{load.origin}</span>
                </div>
                <div className="ml-1.5 border-l border-dashed border-border pl-3.5 py-1">
                  <span className="text-[10px] text-muted-foreground">
                    {load.distanceMiles} mi from you
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <MapPin className="size-3.5 text-primary shrink-0" />
                  <span className="text-sm font-semibold text-foreground">{load.destination}</span>
                </div>
              </div>
              <div className="text-right">
                <p className="text-lg font-bold text-primary">
                  ${(load.carrierCost || load.revenue * 0.8).toLocaleString()}
                </p>
                <p className="text-[10px] text-muted-foreground">carrier rate</p>
              </div>
            </div>

            {/* Details row */}
            <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <Truck className="size-3" />
                {load.equipment || 'Dry Van'}
              </span>
              <span className="flex items-center gap-1">
                <Package className="size-3" />
                {load.weight ? `${(load.weight / 1000).toFixed(0)}k lbs` : '--'}
              </span>
              <span className="flex items-center gap-1">
                <Calendar className="size-3" />
                {formatDate(load.pickupDate)}
              </span>
            </div>

            {load.shipperName && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                Shipper: {load.shipperName}
              </p>
            )}

            {/* Accept button */}
            <button
              onClick={() => acceptLoad(load.id)}
              disabled={!!acceptingId}
              className={cn(
                'mt-3 flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-bold transition-all active:scale-[0.98]',
                acceptingId === load.id
                  ? 'bg-primary/50 text-primary-foreground'
                  : 'bg-primary text-primary-foreground'
              )}
            >
              {acceptingId === load.id ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="size-4" />
              )}
              {acceptingId === load.id ? 'Accepting...' : 'Accept Load'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
