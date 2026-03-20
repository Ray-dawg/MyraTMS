"use client"

import { useState, useEffect, useCallback } from "react"
import { TrackingHeader } from "@/components/tracking/tracking-header"
import { StatusBanner } from "@/components/tracking/status-banner"
import { TrackingMap } from "@/components/tracking/tracking-map"
import { ShipmentDetails } from "@/components/tracking/shipment-details"
import { ActivityTimeline } from "@/components/tracking/activity-timeline"
import { PODSection } from "@/components/tracking/pod-section"
import { DocumentsSection, TrackingDocument } from "@/components/tracking/documents-section"
import { TrackingFooter } from "@/components/tracking/tracking-footer"
import { RefreshCw, Shield } from "lucide-react"

type LoadStatus = "booked" | "picked_up" | "in_transit" | "break_point" | "docking" | "delivered"

interface ShipmentEvent {
  id: string
  status: string
  location: string
  timestamp: string
  note?: string
  completed: boolean
  active?: boolean
}

interface ShipmentData {
  loadNumber: string
  poNumber: string
  carrier: string
  lastUpdated: string
  status: LoadStatus
  progress: number
  eta: string
  currentCity: string
  miles: number
  origin: {
    city: string
    state: string
    address: string
    date: string
    time: string
    lat?: number | null
    lng?: number | null
  }
  destination: {
    city: string
    state: string
    address: string
    date: string
    time: string
    lat?: number | null
    lng?: number | null
  }
  currentLat?: number | null
  currentLng?: number | null
  commodity: string
  weight: string
  pieces: number
  shipper: string
  events: ShipmentEvent[]
  isDelivered: boolean
  podUrl?: string
  driver: { firstName: string; phone: string } | null
}

interface TrackingClientProps {
  shipment: ShipmentData
  token: string
  apiUrl: string
  documents: TrackingDocument[]
}

export function TrackingClient({ shipment: initialShipment, token, apiUrl, documents }: TrackingClientProps) {
  const [shipment, setShipment] = useState(initialShipment)
  const [refreshing, setRefreshing] = useState(false)

  // SSE real-time updates
  useEffect(() => {
    if (shipment.isDelivered) return

    let eventSource: EventSource | null = null

    try {
      eventSource = new EventSource(`${apiUrl}/api/tracking/${token}/sse`)

      eventSource.addEventListener("update", (event) => {
        try {
          const data = JSON.parse(event.data)
          setShipment((prev) => ({
            ...prev,
            status: mapStatusString(data.status),
            progress: statusToProgress(data.status),
            currentCity: prev.currentCity, // keep existing city
            lastUpdated: formatRelativeTime(data.lastUpdated),
            isDelivered: data.isDelivered || false,
            eta: data.currentEta
              ? new Date(data.currentEta).toLocaleString("en-US", {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  hour12: true,
                }) + " EST"
              : prev.eta,
          }))
        } catch {
          // Invalid event data, skip
        }
      })

      eventSource.onerror = () => {
        // SSE will automatically reconnect
      }
    } catch {
      // SSE not supported or connection failed — fall back to polling
    }

    return () => {
      eventSource?.close()
    }
  }, [token, apiUrl, shipment.isDelivered])

  // Manual refresh
  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await fetch(`${apiUrl}/api/tracking/${token}`)
      if (res.ok) {
        const data = await res.json()
        setShipment((prev) => ({
          ...prev,
          status: mapStatusString(data.status),
          progress: statusToProgress(data.status),
          lastUpdated: formatRelativeTime(data.lastUpdated),
          isDelivered: data.isDelivered,
          eta: data.currentEta
            ? new Date(data.currentEta).toLocaleString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
              }) + " EST"
            : prev.eta,
        }))
      }
    } catch {
      // Refresh failed silently
    } finally {
      setTimeout(() => setRefreshing(false), 800)
    }
  }, [apiUrl, token])

  const d = shipment

  return (
    <div className="flex min-h-screen flex-col bg-background font-sans">
      <TrackingHeader
        loadNumber={d.loadNumber}
        shipper={d.shipper}
        carrier={d.carrier}
        lastUpdated={d.lastUpdated}
      />

      <StatusBanner
        status={d.status}
        eta={d.eta}
        currentCity={d.currentCity}
        miles={d.miles}
      />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 lg:px-6">
        {/* Subheader row */}
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground">Tracking</p>
            <span className="font-mono text-xs font-semibold text-foreground">{d.loadNumber}</span>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              for <span className="font-medium text-foreground">{d.shipper}</span>
            </span>
          </div>
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[11px] font-medium text-muted-foreground transition-all hover:border-primary/30 hover:text-foreground"
            aria-label="Refresh tracking data"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {/* Map */}
        <div className="mb-5">
          <TrackingMap
            originCity={`${d.origin.city}, ${d.origin.state}`}
            destinationCity={`${d.destination.city}, ${d.destination.state}`}
            progress={d.progress}
            currentCity={d.currentCity}
            originLat={d.origin.lat}
            originLng={d.origin.lng}
            destLat={d.destination.lat}
            destLng={d.destination.lng}
            currentLat={d.currentLat}
            currentLng={d.currentLng}
          />
        </div>

        {/* Details */}
        <div className="mb-5">
          <ShipmentDetails
            origin={d.origin}
            destination={d.destination}
            commodity={d.commodity}
            weight={d.weight}
            pieces={d.pieces}
            loadNumber={d.loadNumber}
            poNumber={d.poNumber}
          />
        </div>

        {/* Timeline + POD + Carrier */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <ActivityTimeline events={d.events} />
          </div>
          <div className="flex flex-col gap-4 lg:col-span-2">
            <PODSection
              isDelivered={d.isDelivered}
              podUrl={d.podUrl}
              deliveredAt={undefined}
              signedBy={undefined}
            />

            <DocumentsSection documents={documents} />

            {/* Carrier Card */}
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="border-b border-border/60 px-5 py-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Carrier
                </h3>
              </div>
              <div className="p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary text-sm font-bold">
                    {d.carrier.charAt(0)}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{d.carrier}</p>
                  </div>
                </div>

                {d.driver && (
                  <div className="space-y-0">
                    <div className="flex items-center justify-between py-2.5 border-b border-border/60">
                      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        Driver
                      </span>
                      <span className="text-xs font-medium text-foreground">{d.driver.firstName}</span>
                    </div>
                  </div>
                )}

                <div className="mt-4 flex items-center gap-1.5 rounded-lg bg-secondary/60 px-3 py-2">
                  <Shield className="h-3 w-3 text-primary" />
                  <span className="text-[10px] text-muted-foreground">Carrier verified and insured</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      <TrackingFooter />
    </div>
  )
}

// Helper functions for the client component

function mapStatusString(status: string): LoadStatus {
  const s = status.toLowerCase().replace(/\s+/g, "_")
  const statusMap: Record<string, LoadStatus> = {
    created: "booked",
    quoted: "booked",
    booked: "booked",
    assigned: "booked",
    accepted: "booked",
    at_pickup: "picked_up",
    picked_up: "picked_up",
    in_transit: "in_transit",
    at_delivery: "docking",
    delivered: "delivered",
    invoiced: "delivered",
    paid: "delivered",
    dispatched: "in_transit",
  }
  return statusMap[s] || "in_transit"
}

function statusToProgress(status: string): number {
  const s = status.toLowerCase().replace(/\s+/g, "_")
  const progressMap: Record<string, number> = {
    created: 0.0,
    quoted: 0.05,
    booked: 0.1,
    assigned: 0.15,
    accepted: 0.2,
    at_pickup: 0.25,
    picked_up: 0.3,
    in_transit: 0.55,
    at_delivery: 0.85,
    docking: 0.9,
    delivered: 1.0,
    invoiced: 1.0,
    paid: 1.0,
    dispatched: 0.4,
  }
  return progressMap[s] ?? 0.5
}

function formatRelativeTime(isoStr: string): string {
  try {
    const d = new Date(isoStr)
    const diffMs = Date.now() - d.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return "Just now"
    if (diffMin < 60) return `${diffMin} min ago`
    const diffHrs = Math.floor(diffMin / 60)
    if (diffHrs < 24) return `${diffHrs}h ago`
    return `${Math.floor(diffHrs / 24)}d ago`
  } catch {
    return "Unknown"
  }
}
