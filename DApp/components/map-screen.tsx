'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Navigation,
  Phone,
  ChevronUp,
  ChevronDown,
  MapPin,
  Clock,
  Truck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { StatusStepper } from '@/components/status-stepper'
import type { Load } from '@/lib/mock-data'
import { statusLabels } from '@/lib/mock-data'

interface MapScreenProps {
  activeLoad: Load | undefined
  onViewDetails: () => void
  driverPosition?: { latitude: number; longitude: number } | null
}

export function MapScreen({ activeLoad, onViewDetails, driverPosition }: MapScreenProps) {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<unknown>(null)
  const mbRef = useRef<typeof import('mapbox-gl').default | null>(null)
  // 'hidden' = fully retracted, 'collapsed' = summary bar, 'expanded' = full details
  const [panelState, setPanelState] = useState<'hidden' | 'collapsed' | 'expanded'>('collapsed')
  const [mapLoaded, setMapLoaded] = useState(false)

  const initMap = useCallback(async () => {
    if (!mapContainer.current || mapRef.current) return

    const mapboxModule = await import('mapbox-gl')
    await import('mapbox-gl/dist/mapbox-gl.css')
    const mb = mapboxModule.default
    mbRef.current = mb

    mb.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || ''

    const centerLat = activeLoad
      ? (activeLoad.pickup.lat + activeLoad.delivery.lat) / 2
      : 31.0
    const centerLng = activeLoad
      ? (activeLoad.pickup.lng + activeLoad.delivery.lng) / 2
      : -97.0

    const mapInstance = new mb.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [centerLng, centerLat],
      zoom: activeLoad ? 6 : 5,
      attributionControl: false,
    })

    mapInstance.addControl(
      new mb.NavigationControl({ showCompass: false }),
      'top-right'
    )

    mapInstance.on('load', () => {
      setMapLoaded(true)
    })

    mapRef.current = mapInstance
  }, [activeLoad])

  // Add markers once map is loaded
  useEffect(() => {
    const m = mapRef.current as import('mapbox-gl').Map | null
    const mb = mbRef.current
    if (!m || !mb || !mapLoaded || !activeLoad) return

    // Clear existing markers
    const existingMarkers = document.querySelectorAll('.mapboxgl-marker')
    existingMarkers.forEach((el) => el.remove())

    // Pickup marker
    const pickupEl = document.createElement('div')
    pickupEl.className = 'pickup-marker'
    pickupEl.innerHTML = `
      <div style="
        width: 32px; height: 32px; border-radius: 50%;
        background: #4a90d9; border: 3px solid #f0f0f0;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        font-size: 14px; color: white; font-weight: 700;
      ">P</div>
    `
    new mb.Marker(pickupEl)
      .setLngLat([activeLoad.pickup.lng, activeLoad.pickup.lat])
      .addTo(m)

    // Delivery marker
    const deliveryEl = document.createElement('div')
    deliveryEl.className = 'delivery-marker'
    deliveryEl.innerHTML = `
      <div style="
        width: 32px; height: 32px; border-radius: 50%;
        background: #c4983a; border: 3px solid #f0f0f0;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        font-size: 14px; color: #1a1f35; font-weight: 700;
      ">D</div>
    `
    new mb.Marker(deliveryEl)
      .setLngLat([activeLoad.delivery.lng, activeLoad.delivery.lat])
      .addTo(m)

    // Simulated truck position (between pickup and delivery)
    const truckLat = driverPosition?.latitude ??
      (activeLoad.pickup.lat + (activeLoad.delivery.lat - activeLoad.pickup.lat) * 0.3)
    const truckLng = driverPosition?.longitude ??
      (activeLoad.pickup.lng + (activeLoad.delivery.lng - activeLoad.pickup.lng) * 0.3)

    const truckEl = document.createElement('div')
    truckEl.innerHTML = `
      <div style="
        width: 36px; height: 36px; border-radius: 50%;
        background: #48b068; border: 3px solid #f0f0f0;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 0 12px rgba(100,200,140,0.5);
      ">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/>
          <path d="M15 18H9"/>
          <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/>
          <circle cx="17" cy="18" r="2"/>
          <circle cx="7" cy="18" r="2"/>
        </svg>
      </div>
    `

    new mb.Marker(truckEl).setLngLat([truckLng, truckLat]).addTo(m)

    // Add route line
    const routeCoords: [number, number][] = [
      [activeLoad.pickup.lng, activeLoad.pickup.lat],
      [truckLng, truckLat],
      [activeLoad.delivery.lng, activeLoad.delivery.lat],
    ]

    if (m.getSource('route')) {
      const src = m.getSource('route') as import('mapbox-gl').GeoJSONSource
      src.setData({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: routeCoords },
      })
    } else {
      m.addSource('route', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: routeCoords },
        },
      })
      m.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#c4983a',
          'line-width': 3,
          'line-dasharray': [2, 2],
        },
      })
    }

    // Fit bounds
    const bounds = new mb.LngLatBounds()
    bounds.extend([activeLoad.pickup.lng, activeLoad.pickup.lat])
    bounds.extend([activeLoad.delivery.lng, activeLoad.delivery.lat])
    bounds.extend([truckLng, truckLat])
    m.fitBounds(bounds, { padding: { top: 80, bottom: 260, left: 40, right: 40 } })
  }, [activeLoad, mapLoaded, driverPosition])

  useEffect(() => {
    initMap()
    return () => {
      const m = mapRef.current as import('mapbox-gl').Map | null
      if (m) {
        m.remove()
        mapRef.current = null
      }
    }
  }, [initMap])

  const formatTime = (iso: string) => {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* Top bar */}
      <div className="safe-top absolute top-0 left-0 right-0 z-10 flex items-center justify-between bg-gradient-to-b from-background/90 to-transparent px-4 pb-6 pt-3">
        <div>
          <h1 className="text-lg font-bold text-foreground">DriverPulse</h1>
          <p className="text-xs text-muted-foreground">
            {activeLoad ? `Active: ${activeLoad.id}` : 'No active load'}
          </p>
        </div>
        {activeLoad && (
          <Badge className="bg-primary text-primary-foreground">
            {statusLabels[activeLoad.status]}
          </Badge>
        )}
      </div>

      {/* Map */}
      <div ref={mapContainer} className="flex-1" />

      {/* Floating pill to restore panel when hidden */}
      {activeLoad && panelState === 'hidden' && (
        <button
          onClick={() => setPanelState('collapsed')}
          className="absolute bottom-22 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card/95 px-4 py-2.5 shadow-lg backdrop-blur-md transition-all active:scale-95"
          aria-label="Show load panel"
        >
          <ChevronUp className="size-4 text-primary" />
          <span className="text-xs font-semibold text-foreground">
            {activeLoad.pickup.city} to {activeLoad.delivery.city}
          </span>
        </button>
      )}

      {/* Bottom panel */}
      {activeLoad && panelState !== 'hidden' && (
        <div
          className="absolute bottom-0 left-0 right-0 z-10 rounded-t-2xl border-t border-border bg-card/95 pb-20 backdrop-blur-md transition-all duration-300"
        >
          {/* Drag handle area with swipe-down to hide */}
          <div className="flex items-center justify-between px-4 pt-2 pb-0">
            <button
              onClick={() => setPanelState('hidden')}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Hide panel"
            >
              <ChevronDown className="size-4" />
              <span className="text-[10px] font-medium uppercase tracking-wider">Hide</span>
            </button>
            <button
              onClick={() => setPanelState(panelState === 'expanded' ? 'collapsed' : 'expanded')}
              className="flex items-center justify-center py-1"
              aria-label={panelState === 'expanded' ? 'Collapse panel' : 'Expand panel'}
            >
              <div className="h-1 w-10 rounded-full bg-muted-foreground/30" />
            </button>
            <button
              onClick={() => setPanelState(panelState === 'expanded' ? 'collapsed' : 'expanded')}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
              aria-label={panelState === 'expanded' ? 'Show less' : 'Show more'}
            >
              <span className="text-[10px] font-medium uppercase tracking-wider">
                {panelState === 'expanded' ? 'Less' : 'More'}
              </span>
              <ChevronUp className={cn('size-4 transition-transform', panelState === 'expanded' && 'rotate-180')} />
            </button>
          </div>

          <div className="px-4 pb-3">
            {/* Quick info */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {activeLoad.pickup.city}, {activeLoad.pickup.state}
                </p>
                <p className="text-xs text-muted-foreground">to</p>
                <p className="text-sm font-semibold text-foreground">
                  {activeLoad.delivery.city}, {activeLoad.delivery.state}
                </p>
              </div>
              <div className="flex gap-2">
                <a
                  href={`tel:${activeLoad.brokerPhone}`}
                  className="flex size-10 items-center justify-center rounded-full bg-secondary text-foreground transition-colors hover:bg-secondary/80"
                  aria-label="Call broker"
                >
                  <Phone className="size-4" />
                </a>
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${activeLoad.delivery.lat},${activeLoad.delivery.lng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
                  aria-label="Navigate to destination"
                >
                  <Navigation className="size-4" />
                </a>
              </div>
            </div>

            {/* Status stepper */}
            <div className="mt-3">
              <StatusStepper status={activeLoad.status} />
            </div>

            {/* Expandable details */}
            {panelState === 'expanded' && (
              <div className="mt-4 space-y-3">
                <div className="flex gap-3">
                  <div className="flex flex-1 items-start gap-2 rounded-lg bg-secondary p-3">
                    <MapPin className="mt-0.5 size-4 shrink-0 text-accent" />
                    <div>
                      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        Pickup
                      </p>
                      <p className="text-xs font-medium text-foreground">
                        {activeLoad.pickup.name}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {activeLoad.pickup.address}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-1 items-start gap-2 rounded-lg bg-secondary p-3">
                    <MapPin className="mt-0.5 size-4 shrink-0 text-primary" />
                    <div>
                      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        Delivery
                      </p>
                      <p className="text-xs font-medium text-foreground">
                        {activeLoad.delivery.name}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {activeLoad.delivery.address}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-4 rounded-lg bg-secondary p-3">
                  <div className="flex items-center gap-1.5">
                    <Truck className="size-3.5 text-muted-foreground" />
                    <span className="text-xs text-foreground">{activeLoad.miles} mi</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Clock className="size-3.5 text-muted-foreground" />
                    <span className="text-xs text-foreground">
                      ETA {formatTime(activeLoad.delivery.scheduledTime)}
                    </span>
                  </div>
                </div>

                <button
                  onClick={onViewDetails}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  View Full Details
                  <ChevronUp className="size-4 rotate-90" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* No active load state */}
      {!activeLoad && (
        <div className="absolute bottom-0 left-0 right-0 z-10 rounded-t-2xl border-t border-border bg-card/95 px-4 pb-20 pt-6 text-center backdrop-blur-md">
          <Truck className="mx-auto mb-2 size-10 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No Active Load</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Check the Loads tab for upcoming assignments
          </p>
        </div>
      )}
    </div>
  )
}
