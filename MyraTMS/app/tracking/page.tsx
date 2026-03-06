"use client"

import { useState, useCallback } from "react"
import { MapPin, List, RefreshCw, Phone, Clock, Truck, Navigation, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Progress } from "@/components/ui/progress"
import { toast } from "sonner"
import { useTrackingPositions, createCheckCall } from "@/lib/api"
import { TrackingMap } from "@/components/tracking-map"
import { useWorkspace } from "@/lib/workspace-context"

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

const statusBadge: Record<string, string> = {
  "On Schedule": "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  Delayed: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  "Off Route": "bg-red-500/10 text-red-400 border-red-500/20",
  "No Signal": "bg-neutral-500/10 text-neutral-400 border-neutral-500/20",
}

function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now()
  if (diff < 0) return "Overdue"
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

export default function TrackingPage() {
  const [viewMode, setViewMode] = useState<"map" | "list">("map")
  const [selectedLoadId, setSelectedLoadId] = useState<string | null>(null)
  const [checkCallOpen, setCheckCallOpen] = useState(false)
  const [ccLoadId, setCcLoadId] = useState<string | null>(null)
  const [ccNotes, setCcNotes] = useState("")
  const [ccStatus, setCcStatus] = useState("on_schedule")
  const [submitting, setSubmitting] = useState(false)
  const { addNotification } = useWorkspace()

  const { data: trackingData, isLoading, mutate: refreshTracking } = useTrackingPositions()

  // Map API response to TrackingPosition interface (handles both formats)
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

  const selected = selectedLoadId ? trackingPositions.find((p) => p.loadId === selectedLoadId) : null

  const onSchedule = trackingPositions.filter((p) => p.status === "On Schedule").length
  const delayed = trackingPositions.filter((p) => p.status === "Delayed" || p.status === "Off Route").length

  const openCheckCall = useCallback((loadId: string) => {
    setCcLoadId(loadId)
    setCcNotes("")
    setCcStatus("on_schedule")
    setCheckCallOpen(true)
  }, [])

  const submitCheckCall = useCallback(async () => {
    setSubmitting(true)
    try {
      await createCheckCall({
        loadId: ccLoadId,
        status: ccStatus,
        notes: ccNotes,
        contactedDriver: true,
      })
      toast.success("Check-call logged", { description: `${ccLoadId} status updated.` })
      addNotification({
        title: `Check-call: ${ccLoadId}`,
        description: ccNotes || "Manual check-call completed",
        type: "info",
        timestamp: new Date().toISOString(),
      })
      setCheckCallOpen(false)
    } catch {
      toast.error("Failed to log check-call")
    } finally {
      setSubmitting(false)
    }
  }, [ccLoadId, ccNotes, ccStatus, addNotification])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Real-Time Tracking</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Monitor in-transit loads and manage check-calls</p>
        </div>
        <div className="flex items-center gap-2">
          {!(trackingData?.apiConnected || trackingData?.api_connected) && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mr-2">
              <div className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
              <span>Mock positions -- connect ELD for live GPS</span>
            </div>
          )}
          {(trackingData?.apiConnected || trackingData?.api_connected) && (
            <div className="flex items-center gap-1.5 text-xs text-success mr-2">
              <div className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
              <span>Live GPS connected</span>
            </div>
          )}
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "map" | "list")}>
            <TabsList className="h-9 bg-secondary/30">
              <TabsTrigger value="map" className="text-xs"><MapPin className="h-3.5 w-3.5 mr-1" />Map</TabsTrigger>
              <TabsTrigger value="list" className="text-xs"><List className="h-3.5 w-3.5 mr-1" />List</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="outline" size="sm" onClick={() => refreshTracking()}><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Refresh</Button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card className="bg-card border-border"><CardContent className="p-4"><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Active Shipments</p><p className="text-2xl font-semibold font-mono text-foreground mt-1">{trackingPositions.length}</p><p className="text-[11px] text-muted-foreground mt-0.5">Currently in transit</p></CardContent></Card>
        <Card className="bg-card border-border"><CardContent className="p-4"><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">On Schedule</p><p className="text-2xl font-semibold font-mono text-emerald-400 mt-1">{onSchedule}</p><p className="text-[11px] text-emerald-400/70 mt-0.5">Running on time</p></CardContent></Card>
        <Card className="bg-card border-border"><CardContent className="p-4"><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Delayed / Issues</p><p className="text-2xl font-semibold font-mono text-amber-400 mt-1">{delayed}</p><p className="text-[11px] text-amber-400/70 mt-0.5">Needs attention</p></CardContent></Card>
        <Card className="bg-card border-border"><CardContent className="p-4"><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Next Check-Call</p><p className="text-2xl font-semibold font-mono text-foreground mt-1">{trackingPositions.length > 0 ? timeUntil(trackingPositions.reduce((a, b) => new Date(a.nextCheckCall) < new Date(b.nextCheckCall) ? a : b).nextCheckCall) : "--"}</p><p className="text-[11px] text-muted-foreground mt-0.5">Earliest upcoming</p></CardContent></Card>
      </div>

      {/* Map or List */}
      {viewMode === "map" ? (
        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2">
            <TrackingMap positions={trackingPositions} selectedLoadId={selectedLoadId} onSelect={setSelectedLoadId} />
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-foreground">Shipments</h3>
            {trackingPositions.map((p) => (
              <Card
                key={p.loadId}
                className={`bg-card border-border cursor-pointer transition-colors hover:bg-secondary/30 ${selectedLoadId === p.loadId ? "ring-1 ring-ring" : ""}`}
                onClick={() => setSelectedLoadId(p.loadId === selectedLoadId ? null : p.loadId)}
              >
                <CardContent className="p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium font-mono text-foreground">{p.loadId}</span>
                    <Badge variant="outline" className={`text-[10px] border ${statusBadge[p.status] || ""}`}>{p.status}</Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{p.origin} → {p.destination}</p>
                  <div className="mt-2">
                    <Progress value={p.progressPercent} className="h-1" />
                    <div className="flex items-center justify-between mt-1.5">
                      <span className="text-[10px] text-muted-foreground">{p.progressPercent}% complete</span>
                      <span className="text-[10px] text-muted-foreground">{p.speed > 0 ? `${p.speed} mph ${p.heading}` : "Stopped"}</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground"><Clock className="h-3 w-3" />Check-call in {timeUntil(p.nextCheckCall)}</div>
                    <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2" onClick={(e) => { e.stopPropagation(); openCheckCall(p.loadId) }}><Phone className="h-3 w-3 mr-1" />Log Call</Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ) : (
        <Card className="bg-card border-border">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="border-b-border hover:bg-transparent">
                  <TableHead className="text-[11px] font-medium text-muted-foreground">Load</TableHead>
                  <TableHead className="text-[11px] font-medium text-muted-foreground">Carrier</TableHead>
                  <TableHead className="text-[11px] font-medium text-muted-foreground">Route</TableHead>
                  <TableHead className="text-[11px] font-medium text-muted-foreground">Status</TableHead>
                  <TableHead className="text-[11px] font-medium text-muted-foreground">Progress</TableHead>
                  <TableHead className="text-[11px] font-medium text-muted-foreground">Speed</TableHead>
                  <TableHead className="text-[11px] font-medium text-muted-foreground">ETA</TableHead>
                  <TableHead className="text-[11px] font-medium text-muted-foreground">Driver</TableHead>
                  <TableHead className="text-[11px] font-medium text-muted-foreground">Next Check</TableHead>
                  <TableHead className="text-[11px] font-medium text-muted-foreground text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trackingPositions.map((p) => (
                  <TableRow key={p.loadId} className="hover:bg-secondary/30 transition-colors border-b-border">
                    <TableCell><span className="text-xs font-medium font-mono text-foreground">{p.loadId}</span></TableCell>
                    <TableCell><span className="text-xs text-foreground">{p.carrier}</span></TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-muted-foreground">{p.origin.split(",")[0]}</span>
                        <Navigation className="h-3 w-3 text-muted-foreground/50 rotate-90" />
                        <span className="text-xs text-muted-foreground">{p.destination.split(",")[0]}</span>
                      </div>
                    </TableCell>
                    <TableCell><Badge variant="outline" className={`text-[10px] border ${statusBadge[p.status] || ""}`}>{p.status}</Badge></TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 min-w-[100px]">
                        <Progress value={p.progressPercent} className="h-1.5 flex-1" />
                        <span className="text-[10px] font-mono text-muted-foreground">{p.progressPercent}%</span>
                      </div>
                    </TableCell>
                    <TableCell><span className="text-xs font-mono text-foreground">{p.speed > 0 ? `${p.speed} mph` : "Stopped"}</span></TableCell>
                    <TableCell><span className="text-xs text-muted-foreground">{new Date(p.eta).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</span></TableCell>
                    <TableCell>
                      <div>
                        <p className="text-xs text-foreground">{p.driver}</p>
                        <p className="text-[10px] text-muted-foreground">{p.driverPhone}</p>
                      </div>
                    </TableCell>
                    <TableCell><span className="text-xs text-muted-foreground">{timeUntil(p.nextCheckCall)}</span></TableCell>
                    <TableCell className="text-right"><Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => openCheckCall(p.loadId)}><Phone className="h-3 w-3 mr-1" />Check-Call</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Check-Call Dialog */}
      <Dialog open={checkCallOpen} onOpenChange={setCheckCallOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Log Check-Call: {ccLoadId}</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">Record the outcome of this check-in.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Status Update</label>
              <Select value={ccStatus} onValueChange={setCcStatus}>
                <SelectTrigger className="h-9 bg-secondary/30 border-border text-xs"><SelectValue /></SelectTrigger>
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
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Notes</label>
              <Textarea placeholder="Driver confirmed ETA, weather delay in Oklahoma..." className="bg-secondary/30 border-border text-sm min-h-[80px] resize-none" value={ccNotes} onChange={(e) => setCcNotes(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCheckCallOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={submitCheckCall} disabled={submitting}>
              {submitting && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />Log Check-Call
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
