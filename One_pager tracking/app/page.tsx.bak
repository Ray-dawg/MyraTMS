"use client"

import { useState } from "react"
import { TrackingHeader } from "@/components/tracking/tracking-header"
import { StatusBanner } from "@/components/tracking/status-banner"
import { TrackingMap } from "@/components/tracking/tracking-map"
import { ShipmentDetails } from "@/components/tracking/shipment-details"
import { ActivityTimeline } from "@/components/tracking/activity-timeline"
import { PODSection } from "@/components/tracking/pod-section"
import { TrackingFooter } from "@/components/tracking/tracking-footer"
import { RefreshCw, Shield } from "lucide-react"

// ---------- Mock Data (swap with TMS fetch via unique URL token) ----------
const MOCK_SHIPMENT = {
  loadNumber: "MYR-2024-08471",
  poNumber: "PO-88321 / REF-55102",
  carrier: "Apex Freight LLC",
  lastUpdated: "2 min ago",
  status: "in_transit" as const,
  progress: 0.54,
  eta: "Fri, Feb 28 · 2:30 PM EST",
  currentCity: "Nashville, TN",
  miles: 312,
  origin: {
    city: "Chicago",
    state: "IL",
    address: "1420 W Fulton St, Chicago, IL 60607",
    date: "Thu, Feb 27",
    time: "7:00 AM CST",
    lat: 41.8781,
    lng: -87.6298,
  },
  destination: {
    city: "Atlanta",
    state: "GA",
    address: "2550 Cumberland Pkwy SE, Atlanta, GA 30339",
    date: "Fri, Feb 28",
    time: "2:30 PM EST",
    lat: 33.7490,
    lng: -84.3880,
  },
  currentLat: 36.1627,
  currentLng: -86.7816,
  commodity: "Consumer Electronics",
  weight: "38,200 lbs",
  pieces: 22,
  shipper: "Acme Electronics Corp",
  events: [
    {
      id: "booked",
      status: "Load Booked",
      location: "Chicago, IL",
      timestamp: "Wed, Feb 26 · 4:15 PM",
      note: "Load confirmed and carrier assigned.",
      completed: true,
      active: false,
    },
    {
      id: "picked_up",
      status: "Picked Up",
      location: "Chicago, IL · 1420 W Fulton St",
      timestamp: "Thu, Feb 27 · 7:22 AM",
      note: "Driver checked in. Trailer sealed. BOL #44821.",
      completed: true,
      active: false,
    },
    {
      id: "checkpoint",
      status: "En Route Checkpoint",
      location: "Indianapolis, IN · I-65 S",
      timestamp: "Thu, Feb 27 · 11:48 AM",
      note: "Routine GPS ping. All clear.",
      completed: true,
      active: false,
    },
    {
      id: "in_transit",
      status: "In Transit",
      location: "Nashville, TN",
      timestamp: "Thu, Feb 27 · 3:10 PM",
      note: "Driver on I-24 E. On schedule.",
      completed: false,
      active: true,
    },
    {
      id: "break_point",
      status: "Break-point / Transit Stop",
      location: "Memphis, TN · Love's Travel Stop",
      timestamp: "Fri, Feb 28 · 12:45 PM",
      note: "Driver rest break. Trailer secured.",
      completed: false,
      active: false,
    },
    {
      id: "docking",
      status: "Docking",
      location: "Atlanta, GA · 2550 Cumberland Pkwy SE",
      timestamp: "Estimated · Fri, Feb 28 · 2:00 PM",
      note: "Awaiting dock assignment and bay availability.",
      completed: false,
      active: false,
    },
    {
      id: "delivered",
      status: "Delivered",
      location: "Atlanta, GA · 2550 Cumberland Pkwy SE",
      timestamp: "Estimated · Fri, Feb 28 · 2:30 PM",
      completed: false,
      active: false,
    },
  ],
  isDelivered: false,
  podUrl: undefined,
}

export default function TrackingPage() {
  const [refreshing, setRefreshing] = useState(false)

  function handleRefresh() {
    setRefreshing(true)
    setTimeout(() => setRefreshing(false), 1200)
  }

  const d = MOCK_SHIPMENT

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
            <p className="text-xs text-muted-foreground">
              Tracking
            </p>
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
            originCity="Chicago, IL"
            destinationCity="Atlanta, GA"
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
                    <p className="text-[11px] text-muted-foreground">MC # 884721 · DOT # 3219044</p>
                  </div>
                </div>
                <div className="space-y-0">
                  <div className="flex items-center justify-between py-2.5 border-b border-border/60">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Driver</span>
                    <span className="text-xs font-medium text-foreground">James R.</span>
                  </div>
                  <div className="flex items-center justify-between py-2.5 border-b border-border/60">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Truck</span>
                    <span className="text-xs font-medium text-foreground">Kenworth T680</span>
                  </div>
                  <div className="flex items-center justify-between py-2.5 border-b border-border/60">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Plate</span>
                    <span className="font-mono text-xs font-medium text-foreground">IL-482T</span>
                  </div>
                  <div className="flex items-center justify-between py-2.5">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Trailer</span>
                    <span className="text-xs font-medium text-foreground">{"53' Dry Van · TRL-9921"}</span>
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-1.5 rounded-lg bg-secondary/60 px-3 py-2">
                  <Shield className="h-3 w-3 text-primary" />
                  <span className="text-[10px] text-muted-foreground">
                    Carrier verified and insured
                  </span>
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
