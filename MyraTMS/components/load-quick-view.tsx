"use client"

import { useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import {
  X, ExternalLink, MapPin, Calendar, DollarSign, Truck, AlertTriangle,
  Sparkles, Navigation, Clock, Phone, CheckCircle2, Radio,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { StatusBadge } from "@/components/status-badge"
import { useLoad } from "@/lib/api"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useTrackingPositions, createCheckCall } from "@/lib/api"
import { toast } from "sonner"

interface TrackingPosition {
  loadId: string
  carrier: string
  origin: string
  destination: string
  currentLat: number
  currentLng: number
  originLat: number
  originLng: number
  destLat: number
  destLng: number
  speed: number
  heading: string
  lastUpdate: string
  eta: string
  status: string
  progressPercent: number
  nextCheckCall: string
  driver: string
  driverPhone: string
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(value)
}

const statusColors: Record<string, string> = {
  "On Schedule": "text-emerald-400",
  Delayed: "text-amber-400",
  "Off Route": "text-red-400",
  "No Signal": "text-neutral-400",
}

const statusBg: Record<string, string> = {
  "On Schedule": "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  Delayed: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  "Off Route": "bg-red-500/10 text-red-400 border-red-500/20",
  "No Signal": "bg-neutral-500/10 text-neutral-400 border-neutral-500/20",
}

const svgStatusColors: Record<string, string> = {
  "On Schedule": "#22c55e",
  Delayed: "#f59e0b",
  "Off Route": "#ef4444",
  "No Signal": "#6b7280",
}

const US_BOUNDS = { minLat: 25, maxLat: 49, minLng: -125, maxLng: -67 }

function toSvg(lat: number, lng: number): { x: number; y: number } {
  const x = ((lng - US_BOUNDS.minLng) / (US_BOUNDS.maxLng - US_BOUNDS.minLng)) * 500 + 10
  const y = ((US_BOUNDS.maxLat - lat) / (US_BOUNDS.maxLat - US_BOUNDS.minLat)) * 240 + 10
  return { x, y }
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now()
  if (diff < 0) return "Overdue"
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

function InlineTrackingMap({ position }: { position: TrackingPosition }) {
  const origin = toSvg(position.originLat, position.originLng)
  const dest = toSvg(position.destLat, position.destLng)
  const current = toSvg(position.currentLat, position.currentLng)
  const color = svgStatusColors[position.status]

  return (
    <div className="relative w-full rounded-lg border border-border bg-secondary/10 overflow-hidden" style={{ aspectRatio: "2.2/1" }}>
      <svg viewBox="0 0 520 260" className="w-full h-full">
        <defs>
          <pattern id="trackGrid" width="26" height="26" patternUnits="userSpaceOnUse">
            <path d="M 26 0 L 0 0 0 26" fill="none" stroke="currentColor" strokeOpacity="0.04" strokeWidth="0.5" />
          </pattern>
        </defs>
        <rect width="520" height="260" fill="url(#trackGrid)" />

        {/* Route line dashed */}
        <line x1={origin.x} y1={origin.y} x2={dest.x} y2={dest.y}
          stroke={color} strokeWidth="1.5" strokeOpacity="0.2" strokeDasharray="6,4" />
        {/* Completed segment */}
        <line x1={origin.x} y1={origin.y} x2={current.x} y2={current.y}
          stroke={color} strokeWidth="2" strokeOpacity="0.6" />

        {/* Origin */}
        <circle cx={origin.x} cy={origin.y} r="4" fill="none" stroke={color} strokeWidth="1.5" strokeOpacity="0.5" />
        <text x={origin.x} y={origin.y - 8} textAnchor="middle" fill="currentColor" fontSize="8" opacity="0.4">{position.origin.split(",")[0]}</text>

        {/* Destination */}
        <circle cx={dest.x} cy={dest.y} r="4" fill={color} fillOpacity="0.2" stroke={color} strokeWidth="1.5" strokeOpacity="0.5" />
        <text x={dest.x} y={dest.y - 8} textAnchor="middle" fill="currentColor" fontSize="8" opacity="0.4">{position.destination.split(",")[0]}</text>

        {/* Current position */}
        <circle cx={current.x} cy={current.y} r="8" fill={color} fillOpacity="0.15" stroke={color} strokeWidth="1.5" />
        <circle cx={current.x} cy={current.y} r="3.5" fill={color} />
        <circle cx={current.x} cy={current.y} r="14" fill="none" stroke={color} strokeWidth="1" strokeOpacity="0.25" strokeDasharray="3,3">
          <animateTransform attributeName="transform" type="rotate" from={`0 ${current.x} ${current.y}`} to={`360 ${current.x} ${current.y}`} dur="8s" repeatCount="indefinite" />
        </circle>

        {/* Label */}
        <text x={current.x + 12} y={current.y + 4} fill="currentColor" fontSize="9" fontFamily="monospace" opacity="0.6">
          {position.speed > 0 ? `${position.speed} mph ${position.heading}` : "Stopped"}
        </text>
      </svg>
    </div>
  )
}

export function LoadQuickView({
  loadId,
  open,
  onClose,
}: {
  loadId: string | null
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const { data: rawLoad } = useLoad(loadId)
  const { data: trackingData } = useTrackingPositions()

  const [checkCallOpen, setCheckCallOpen] = useState(false)
  const [ccNotes, setCcNotes] = useState("")
  const [ccStatus, setCcStatus] = useState("on_schedule")
  const [submitting, setSubmitting] = useState(false)

  const submitCheckCall = useCallback(async () => {
    setSubmitting(true)
    try {
      await createCheckCall({
        loadId,
        status: ccStatus,
        notes: ccNotes,
        contactedDriver: true,
      })
      toast.success("Check-call logged", { description: `${loadId} status updated.` })
      setCheckCallOpen(false)
      setCcNotes("")
      setCcStatus("on_schedule")
    } catch {
      toast.error("Failed to log check-call")
    } finally {
      setSubmitting(false)
    }
  }, [loadId, ccStatus, ccNotes])

  if (!rawLoad) return null

  const trackingPositions: TrackingPosition[] = (trackingData?.positions || []).map((p: Record<string, unknown>) => ({
    loadId: (p.loadId || p.load_id || "") as string,
    carrier: (p.carrier || "") as string,
    origin: (p.origin || "") as string,
    destination: (p.destination || "") as string,
    currentLat: Number(p.currentLat || p.lat || 0),
    currentLng: Number(p.currentLng || p.lng || 0),
    originLat: Number(p.originLat || p.origin_lat || 0),
    originLng: Number(p.originLng || p.origin_lng || 0),
    destLat: Number(p.destLat || p.dest_lat || 0),
    destLng: Number(p.destLng || p.dest_lng || 0),
    speed: Number(p.speed || 0),
    heading: (p.heading || "N") as string,
    lastUpdate: (p.lastUpdate || p.updated_at || new Date().toISOString()) as string,
    eta: (p.eta || new Date(Date.now() + 3600000).toISOString()) as string,
    status: (p.status || "On Schedule") as string,
    progressPercent: Number(p.progressPercent || p.progress_percent || 50),
    nextCheckCall: (p.nextCheckCall || p.next_check_call || new Date(Date.now() + 3600000).toISOString()) as string,
    driver: (p.driver || p.driver_name || "TBD") as string,
    driverPhone: (p.driverPhone || p.driver_phone || "") as string,
  }))

  const load = {
    id: rawLoad.id as string,
    origin: rawLoad.origin as string,
    destination: rawLoad.destination as string,
    shipper: (rawLoad.shipper_name || "") as string,
    carrier: (rawLoad.carrier_name || "") as string,
    source: rawLoad.source as string,
    status: rawLoad.status as string,
    revenue: Number(rawLoad.revenue) || 0,
    carrierCost: Number(rawLoad.carrier_cost) || 0,
    margin: Number(rawLoad.margin) || 0,
    marginPercent: Number(rawLoad.margin_percent) || 0,
    pickupDate: (rawLoad.pickup_date || "") as string,
    deliveryDate: (rawLoad.delivery_date || "") as string,
    assignedRep: (rawLoad.assigned_rep || "") as string,
    equipment: (rawLoad.equipment || "") as string,
    weight: (rawLoad.weight || "") as string,
    riskFlag: rawLoad.risk_flag as boolean || false,
  }

  // Look up tracking data for this load
  const tracking: TrackingPosition | undefined = trackingPositions.find((p) => p.loadId === load.id)
  const isInTransit = ["In Transit", "Dispatched"].includes(load.status)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="p-6 pb-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-base font-semibold">{load.id}</DialogTitle>
              {load.riskFlag && (
                <Badge variant="outline" className="text-warning border-warning/30 text-[10px] gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  At Risk
                </Badge>
              )}
              <StatusBadge status={load.status} />
              <StatusBadge status={load.source} />
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={() => { onClose(); router.push(`/loads/${load.id}`) }}
              >
                <ExternalLink className="h-3 w-3" />
                Full View
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
                <X className="h-3.5 w-3.5" />
                <span className="sr-only">Close</span>
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="p-6 pt-4 space-y-5">
          {/* Route */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 flex-1">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-sm text-foreground">{load.origin}</span>
            </div>
            <div className="flex-1 border-t border-dashed border-border" />
            <div className="flex items-center gap-2 flex-1 justify-end">
              <span className="text-sm text-foreground">{load.destination}</span>
              <MapPin className="h-3.5 w-3.5 text-accent shrink-0" />
            </div>
          </div>

          {/* REAL-TIME TRACKING SECTION */}
          {isInTransit && tracking && (
            <>
              <div className="rounded-lg border border-border bg-secondary/5 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5">
                      <Radio className="h-3.5 w-3.5 text-accent animate-pulse" />
                      <span className="text-xs font-semibold text-foreground uppercase tracking-wider">Live Tracking</span>
                    </div>
                    <Badge variant="outline" className={`text-[10px] border ${statusBg[tracking.status]}`}>
                      {tracking.status}
                    </Badge>
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    Updated {new Date(tracking.lastUpdate).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>

                {/* Inline Map */}
                <InlineTrackingMap position={tracking} />

                {/* Progress Bar */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] text-muted-foreground">Route Progress</span>
                    <span className="text-[11px] font-mono font-medium text-foreground">{tracking.progressPercent}%</span>
                  </div>
                  <Progress value={tracking.progressPercent} className="h-1.5" />
                </div>

                {/* Tracking KPIs */}
                <div className="grid grid-cols-4 gap-3">
                  <div className="p-2.5 rounded-md bg-secondary/30 text-center">
                    <div className="flex items-center justify-center gap-1 mb-1">
                      <Navigation className="h-3 w-3 text-muted-foreground" />
                    </div>
                    <p className="text-xs font-semibold font-mono text-foreground">{tracking.speed > 0 ? `${tracking.speed} mph` : "Stopped"}</p>
                    <p className="text-[9px] text-muted-foreground mt-0.5">{tracking.heading}</p>
                  </div>
                  <div className="p-2.5 rounded-md bg-secondary/30 text-center">
                    <div className="flex items-center justify-center gap-1 mb-1">
                      <Clock className="h-3 w-3 text-muted-foreground" />
                    </div>
                    <p className="text-xs font-semibold font-mono text-foreground">
                      {new Date(tracking.eta).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                    </p>
                    <p className="text-[9px] text-muted-foreground mt-0.5">ETA</p>
                  </div>
                  <div className="p-2.5 rounded-md bg-secondary/30 text-center">
                    <div className="flex items-center justify-center gap-1 mb-1">
                      <Phone className="h-3 w-3 text-muted-foreground" />
                    </div>
                    <p className="text-xs font-semibold font-mono text-foreground">{timeUntil(tracking.nextCheckCall)}</p>
                    <p className="text-[9px] text-muted-foreground mt-0.5">Next Check</p>
                  </div>
                  <div className="p-2.5 rounded-md bg-secondary/30 text-center">
                    <div className="flex items-center justify-center gap-1 mb-1">
                      <Truck className="h-3 w-3 text-muted-foreground" />
                    </div>
                    <p className="text-xs font-semibold text-foreground truncate">{tracking.driver.split(" ")[0]}</p>
                    <p className="text-[9px] text-muted-foreground mt-0.5">{tracking.driverPhone}</p>
                  </div>
                </div>

                {/* Check-Call Actions */}
                {!checkCallOpen ? (
                  <div className="flex items-center gap-2 pt-1">
                    <Button variant="outline" size="sm" className="h-7 text-xs flex-1 gap-1.5" onClick={() => setCheckCallOpen(true)}>
                      <Phone className="h-3 w-3" />
                      Log Check-Call
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs flex-1 gap-1.5" asChild>
                      <a href={`tel:${tracking.driverPhone}`}>
                        <Phone className="h-3 w-3" />
                        Call Driver
                      </a>
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3 pt-1 border-t border-border">
                    <p className="text-[11px] font-medium text-foreground pt-2">Log Check-Call</p>
                    <Select value={ccStatus} onValueChange={setCcStatus}>
                      <SelectTrigger className="h-8 bg-secondary/30 border-border text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="on_schedule">On Schedule</SelectItem>
                        <SelectItem value="delayed">Delayed</SelectItem>
                        <SelectItem value="at_pickup">At Pickup</SelectItem>
                        <SelectItem value="loaded">Loaded - In Transit</SelectItem>
                        <SelectItem value="at_delivery">At Delivery</SelectItem>
                        <SelectItem value="delivered">Delivered</SelectItem>
                        <SelectItem value="no_answer">No Answer</SelectItem>
                      </SelectContent>
                    </Select>
                    <Textarea
                      placeholder="Notes from check-call..."
                      className="bg-secondary/30 border-border text-xs min-h-[60px] resize-none"
                      value={ccNotes}
                      onChange={(e) => setCcNotes(e.target.value)}
                    />
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setCheckCallOpen(false)}>Cancel</Button>
                      <Button size="sm" className="h-7 text-xs gap-1.5" onClick={submitCheckCall}>
                        <CheckCircle2 className="h-3 w-3" />
                        Submit
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* No tracking available notice for in-transit loads */}
          {isInTransit && !tracking && (
            <div className="rounded-lg border border-dashed border-border bg-secondary/5 p-4 text-center">
              <Radio className="h-5 w-5 text-muted-foreground mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">No live tracking data available for this load.</p>
              <p className="text-[10px] text-muted-foreground mt-1">Connect Samsara or Motive ELD for real-time GPS.</p>
            </div>
          )}

          {/* Key Details */}
          <div className="grid grid-cols-4 gap-4">
            <div className="p-3 rounded-md bg-secondary/30">
              <div className="flex items-center gap-1.5 mb-1">
                <Calendar className="h-3 w-3 text-muted-foreground" />
                <p className="text-[10px] text-muted-foreground">Pickup</p>
              </div>
              <p className="text-xs font-medium text-foreground">
                {load.pickupDate ? new Date(load.pickupDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "--"}
              </p>
            </div>
            <div className="p-3 rounded-md bg-secondary/30">
              <div className="flex items-center gap-1.5 mb-1">
                <Calendar className="h-3 w-3 text-muted-foreground" />
                <p className="text-[10px] text-muted-foreground">Delivery</p>
              </div>
              <p className="text-xs font-medium text-foreground">
                {load.deliveryDate ? new Date(load.deliveryDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "--"}
              </p>
            </div>
            <div className="p-3 rounded-md bg-secondary/30">
              <div className="flex items-center gap-1.5 mb-1">
                <Truck className="h-3 w-3 text-muted-foreground" />
                <p className="text-[10px] text-muted-foreground">Equipment</p>
              </div>
              <p className="text-xs font-medium text-foreground">{load.equipment}</p>
            </div>
            <div className="p-3 rounded-md bg-secondary/30">
              <div className="flex items-center gap-1.5 mb-1">
                <DollarSign className="h-3 w-3 text-muted-foreground" />
                <p className="text-[10px] text-muted-foreground">Weight</p>
              </div>
              <p className="text-xs font-medium text-foreground">{load.weight}</p>
            </div>
          </div>

          {/* Financial Summary */}
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center p-3 rounded-md bg-secondary/30">
              <p className="text-[10px] text-muted-foreground">Revenue</p>
              <p className="text-lg font-semibold text-foreground font-mono mt-0.5">{formatCurrency(load.revenue)}</p>
            </div>
            <div className="text-center p-3 rounded-md bg-secondary/30">
              <p className="text-[10px] text-muted-foreground">Carrier Pay</p>
              <p className="text-lg font-semibold text-muted-foreground font-mono mt-0.5">{formatCurrency(load.carrierCost)}</p>
            </div>
            <div className="text-center p-3 rounded-md bg-success/5">
              <p className="text-[10px] text-muted-foreground">Margin</p>
              <p className="text-lg font-semibold text-success font-mono mt-0.5">
                {formatCurrency(load.margin)} <span className="text-xs">({load.marginPercent}%)</span>
              </p>
            </div>
          </div>

          <Separator className="bg-border" />

          {/* Shipper & Carrier */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Shipper</p>
              <div className="p-3 rounded-md bg-secondary/30">
                <p className="text-sm font-medium text-foreground">{load.shipper}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">Shipper details</p>
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Carrier</p>
              <div className="p-3 rounded-md bg-secondary/30">
                <p className="text-sm font-medium text-foreground">{load.carrier}</p>
                {tracking && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">{tracking.driver} - {tracking.driverPhone}</p>
                )}
                {!tracking && <p className="text-[11px] text-muted-foreground mt-0.5">Carrier details</p>}
              </div>
            </div>
          </div>

          {/* AI Summary */}
          <div className="p-3 rounded-md bg-accent/5 border-l-2 border-l-accent">
            <div className="flex items-center gap-1.5 mb-1">
              <Sparkles className="h-3 w-3 text-accent" />
              <p className="text-[11px] font-medium text-foreground">AI Summary</p>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {load.riskFlag
                ? `This load has been flagged at-risk. ${load.carrier} shows declining on-time performance. Consider proactive shipper communication and backup carrier identification.`
                : tracking
                ? `Load is ${tracking.progressPercent}% through route at ${tracking.speed > 0 ? tracking.speed + " mph" : "rest"}. ETA ${new Date(tracking.eta).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}. ${tracking.status === "On Schedule" ? "Tracking on schedule, no issues detected." : `Status: ${tracking.status}. Consider immediate driver contact.`}`
                : `Load performing within expected parameters. ${load.marginPercent}% margin is ${load.marginPercent >= 25 ? "above" : "at"} target. No immediate action required.`}
            </p>
          </div>

          {/* Rep */}
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/10 text-accent text-[10px] font-medium">
              {load.assignedRep ? load.assignedRep.split(" ").map((n) => n[0]).join("") : "?"}
            </div>
            <div>
              <p className="text-xs font-medium text-foreground">{load.assignedRep || "Unassigned"}</p>
              <p className="text-[10px] text-muted-foreground">Account Manager</p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
