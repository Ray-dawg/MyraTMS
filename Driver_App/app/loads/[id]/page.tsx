'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import {
  ArrowLeft,
  MapPin,
  Phone,
  Calendar,
  Truck,
  Weight,
  FileText,
  AlertCircle,
  Loader2,
  Package,
} from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/use-auth'
import { useGPS } from '@/hooks/use-gps'
import { driverFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusFlow } from '@/components/status-flow'
import { GPSTracker } from '@/components/gps-tracker'
import { PODCapture } from '@/components/pod-capture'
import { NavigationChoice } from '@/components/navigation-choice'

interface LoadDetail {
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
  shipper_id: string | null
  carrier_id: string | null
  special_instructions?: string
  commodity?: string
  po_number?: string
  reference_number?: string
  origin_lat?: number | null
  origin_lng?: number | null
  dest_lat?: number | null
  dest_lng?: number | null
  pod_url?: string | null
  revenue?: number
  carrier_cost?: number
}

// Statuses where GPS should be active
const GPS_ACTIVE_STATUSES = ['accepted', 'at_pickup', 'in_transit', 'at_delivery']

export default function LoadDetailPage() {
  const router = useRouter()
  const params = useParams()
  const loadId = params.id as string
  const { requireAuth } = useAuth()

  const [load, setLoad] = useState<LoadDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [showPOD, setShowPOD] = useState(false)
  const [gpsEnabled, setGpsEnabled] = useState(false)

  // GPS hook
  const gps = useGPS({
    loadId,
    enabled: gpsEnabled,
    reportIntervalMs: 30000,
  })

  const fetchLoad = useCallback(async () => {
    try {
      const res = await driverFetch(`/api/loads/${loadId}`)
      if (res.ok) {
        const data = await res.json()
        setLoad(data)

        // Auto-enable GPS for active statuses
        if (GPS_ACTIVE_STATUSES.includes(data.status)) {
          setGpsEnabled(true)
        }

        // Auto-show POD at delivery
        if (data.status === 'at_delivery') {
          setShowPOD(true)
        }
      } else {
        toast.error('Failed to load details')
        router.back()
      }
    } catch {
      toast.error('Network error')
    } finally {
      setLoading(false)
    }
  }, [loadId, router])

  useEffect(() => {
    requireAuth()
  }, [requireAuth])

  useEffect(() => {
    fetchLoad()
  }, [fetchLoad])

  function handleStatusChange(newStatus: string) {
    setLoad((prev) => (prev ? { ...prev, status: newStatus } : prev))

    // Manage GPS based on new status
    if (GPS_ACTIVE_STATUSES.includes(newStatus)) {
      setGpsEnabled(true)
    }

    // Stop GPS when delivered
    if (newStatus === 'delivered') {
      setGpsEnabled(false)
    }
  }

  function handleDeliveryReached() {
    setShowPOD(true)
  }

  function handlePODCaptured(podUrl: string) {
    setLoad((prev) => (prev ? { ...prev, pod_url: podUrl } : prev))
  }

  function formatDate(dateStr: string | null): string {
    if (!dateStr) return 'TBD'
    try {
      return format(parseISO(dateStr), 'EEE, MMM d, yyyy h:mm a')
    } catch {
      return dateStr
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-svh flex-col bg-background">
        <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur-sm">
          <div className="flex items-center gap-3 px-4 py-3">
            <Button variant="ghost" size="icon-sm" onClick={() => router.back()}>
              <ArrowLeft className="size-5" />
            </Button>
            <Skeleton className="h-5 w-24" />
          </div>
        </header>
        <main className="flex-1 px-4 py-4">
          <div className="flex flex-col gap-4">
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-40 w-full rounded-xl" />
            <Skeleton className="h-32 w-full rounded-xl" />
          </div>
        </main>
      </div>
    )
  }

  if (!load) return null

  const isPickupPhase = ['assigned', 'accepted', 'at_pickup'].includes(load.status)
  const navAddress = isPickupPhase ? load.origin : load.destination
  const navLat = isPickupPhase ? load.origin_lat : load.dest_lat
  const navLng = isPickupPhase ? load.origin_lng : load.dest_lng

  return (
    <div className="flex min-h-svh flex-col bg-background pb-4">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur-sm">
        <div className="flex items-center gap-3 px-4 py-3">
          <Button variant="ghost" size="icon-sm" onClick={() => router.push('/loads')}>
            <ArrowLeft className="size-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-base font-semibold font-mono">{load.id}</h1>
          </div>
          <Badge
            variant={
              load.status === 'delivered'
                ? 'success'
                : load.status === 'in_transit'
                ? 'default'
                : 'secondary'
            }
          >
            {load.status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
          </Badge>
        </div>
      </header>

      <main className="flex-1 px-4 py-4 flex flex-col gap-4">
        {/* Status Flow */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Status</CardTitle>
          </CardHeader>
          <CardContent>
            <StatusFlow
              loadId={load.id}
              currentStatus={load.status}
              onStatusChange={handleStatusChange}
              onDeliveryReached={handleDeliveryReached}
            />
          </CardContent>
        </Card>

        {/* GPS Tracker (shown when GPS is or should be active) */}
        {GPS_ACTIVE_STATUSES.includes(load.status) && (
          <GPSTracker
            status={gps.status}
            speedMph={gps.speedMph}
            lastReportedAt={gps.lastReportedAt}
            error={gps.error}
            onToggle={() => setGpsEnabled(!gpsEnabled)}
            enabled={gpsEnabled}
          />
        )}

        {/* Navigation */}
        {load.status !== 'delivered' && (
          <NavigationChoice
            address={navAddress}
            lat={navLat}
            lng={navLng}
            label={isPickupPhase ? 'Navigate to Pickup' : 'Navigate to Delivery'}
          />
        )}

        {/* Route Details */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Route Details</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* Origin */}
            <div className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className="size-3 rounded-full bg-success ring-2 ring-success/20" />
                <div className="h-full w-px bg-border my-1" />
              </div>
              <div className="flex-1 min-w-0 pb-4">
                <p className="text-xs font-medium text-success uppercase tracking-wide">Pickup</p>
                <p className="text-sm font-medium mt-1">{load.origin}</p>
                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                  <Calendar className="size-3" />
                  {formatDate(load.pickup_date)}
                </p>
              </div>
            </div>

            {/* Destination */}
            <div className="flex gap-3">
              <div className="flex flex-col items-center">
                <div className="size-3 rounded-full bg-destructive ring-2 ring-destructive/20" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-destructive uppercase tracking-wide">Delivery</p>
                <p className="text-sm font-medium mt-1">{load.destination}</p>
                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                  <Calendar className="size-3" />
                  {formatDate(load.delivery_date)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Load Info */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Load Information</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              {load.equipment && (
                <div className="flex items-start gap-2">
                  <Truck className="size-4 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="text-xs text-muted-foreground">Equipment</p>
                    <p className="text-sm font-medium">{load.equipment}</p>
                  </div>
                </div>
              )}
              {load.weight && (
                <div className="flex items-start gap-2">
                  <Weight className="size-4 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="text-xs text-muted-foreground">Weight</p>
                    <p className="text-sm font-medium">{load.weight}</p>
                  </div>
                </div>
              )}
              {load.commodity && (
                <div className="flex items-start gap-2">
                  <Package className="size-4 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="text-xs text-muted-foreground">Commodity</p>
                    <p className="text-sm font-medium">{load.commodity}</p>
                  </div>
                </div>
              )}
              {load.reference_number && (
                <div className="flex items-start gap-2">
                  <FileText className="size-4 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="text-xs text-muted-foreground">Reference</p>
                    <p className="text-sm font-medium font-mono">{load.reference_number}</p>
                  </div>
                </div>
              )}
              {load.shipper_name && (
                <div className="col-span-2 flex items-start gap-2">
                  <Package className="size-4 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="text-xs text-muted-foreground">Shipper</p>
                    <p className="text-sm font-medium">{load.shipper_name}</p>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Special Instructions */}
        {load.special_instructions && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <AlertCircle className="size-4 text-warning" />
                Special Instructions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                {load.special_instructions}
              </p>
            </CardContent>
          </Card>
        )}

        {/* POD Capture */}
        {(showPOD || load.status === 'at_delivery' || load.status === 'delivered') && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Proof of Delivery</CardTitle>
            </CardHeader>
            <CardContent>
              <PODCapture
                loadId={load.id}
                onCaptured={handlePODCaptured}
                existingPodUrl={load.pod_url}
              />
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  )
}
