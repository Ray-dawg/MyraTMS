"use client"

import { use, useState } from "react"
import Link from "next/link"
import { ArrowLeft, Shield, ShieldCheck, ShieldAlert, ShieldX, Phone, AlertTriangle, MapPin, Sparkles, FileText, TrendingUp, RefreshCw, Clock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/status-badge"
import { ActivityNotes, type ActivityNote } from "@/components/activity-notes"
import { LoadQuickView } from "@/components/load-quick-view"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { useCarrier, useLoads, useDocuments } from "@/lib/api"
import { cn } from "@/lib/utils"

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(value)
}

export default function CarrierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [quickViewLoadId, setQuickViewLoadId] = useState<string | null>(null)

  const { data: rawCarrier } = useCarrier(id)
  const { data: rawLoads = [] } = useLoads()
  const { data: rawDocs = [] } = useDocuments({ relatedTo: id, relatedType: "Carrier" })

  // Map DB snake_case to camelCase
  const carrier = rawCarrier ? {
    id: rawCarrier.id as string,
    company: rawCarrier.company as string,
    mcNumber: (rawCarrier.mc_number || "") as string,
    dotNumber: (rawCarrier.dot_number || "") as string,
    insuranceStatus: (rawCarrier.insurance_status || "Active") as string,
    performanceScore: Number(rawCarrier.performance_score) || 85,
    onTimePercent: Number(rawCarrier.on_time_percent) || 90,
    lanesCovered: (rawCarrier.lanes_covered || []) as string[],
    riskFlag: rawCarrier.risk_flag as boolean || false,
    contactName: (rawCarrier.contact_name || "") as string,
    contactPhone: (rawCarrier.contact_phone || "") as string,
    authorityStatus: (rawCarrier.authority_status || "Active") as string,
    insuranceExpiry: (rawCarrier.insurance_expiry || "") as string,
    liabilityInsurance: Number(rawCarrier.liability_insurance) || 0,
    cargoInsurance: Number(rawCarrier.cargo_insurance) || 0,
    safetyRating: (rawCarrier.safety_rating || "Not Rated") as string,
    lastFmcsaSync: (rawCarrier.last_fmcsa_sync || "") as string,
    vehicleOosPercent: Number(rawCarrier.vehicle_oos_percent) || 0,
    driverOosPercent: Number(rawCarrier.driver_oos_percent) || 0,
  } : null

  // Map loads from DB rows
  const allLoads = rawLoads.map((l: Record<string, unknown>) => ({
    id: l.id as string,
    origin: l.origin as string,
    destination: l.destination as string,
    shipper: (l.shipper_name || "") as string,
    carrier: (l.carrier_name || "") as string,
    status: (l.status || "Booked") as string,
    revenue: Number(l.revenue) || 0,
    carrierCost: Number(l.carrier_cost) || 0,
    margin: Number(l.margin) || 0,
    marginPercent: Number(l.margin_percent) || 0,
  }))
  const carrierLoads = carrier ? allLoads.filter((l: { carrier: string }) => l.carrier === carrier.company) : []

  // Map documents from DB rows
  const carrierDocs = rawDocs.map((d: Record<string, unknown>) => ({
    id: d.id as string,
    name: d.name as string,
    type: (d.type || "BOL") as string,
    relatedTo: (d.related_to || "") as string,
    status: (d.status || "Pending Review") as string,
  }))

  const totalPaid = carrierLoads.reduce((sum: number, l: any) => sum + l.carrierCost, 0)

  if (!carrier) {
    return (
      <div className="flex flex-col h-full">
        {/* Header skeleton */}
        <div className="border-b border-border px-6 py-4">
          <div className="flex items-center gap-3 mb-1">
            <Skeleton className="h-7 w-7 rounded-md" />
            <Skeleton className="h-10 w-10 rounded-lg" />
            <div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-5 w-[180px]" />
                <Skeleton className="h-5 w-[60px] rounded-full" />
              </div>
              <Skeleton className="h-3 w-[140px] mt-1" />
            </div>
            <div className="ml-auto">
              <Skeleton className="h-8 w-[70px]" />
            </div>
          </div>
        </div>

        {/* Content skeleton */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="grid grid-cols-3 gap-6 p-6">
            {/* Left Column */}
            <div className="col-span-2 space-y-6">
              {/* KPI Cards skeleton */}
              <div className="grid grid-cols-4 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Card key={i} className="border-border bg-card">
                    <CardContent className="p-4">
                      <Skeleton className="h-3 w-[70px] mb-2" />
                      <Skeleton className="h-6 w-[60px]" />
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Load History skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[130px]" />
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div key={i} className="flex items-center justify-between p-3 rounded-md bg-secondary/30">
                        <div className="flex items-center gap-3">
                          <Skeleton className="h-3.5 w-[70px]" />
                          <Skeleton className="h-3.5 w-[180px]" />
                        </div>
                        <div className="flex items-center gap-3">
                          <Skeleton className="h-3.5 w-[60px]" />
                          <Skeleton className="h-5 w-[70px] rounded-full" />
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Activity Notes skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[130px]" />
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {Array.from({ length: 2 }).map((_, i) => (
                      <div key={i} className="p-3 rounded-md bg-secondary/30">
                        <Skeleton className="h-3.5 w-[200px] mb-2" />
                        <Skeleton className="h-3 w-full mb-1" />
                        <Skeleton className="h-3 w-[70%]" />
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Right Column */}
            <div className="space-y-6">
              {/* Contact skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[60px]" />
                </CardHeader>
                <CardContent className="space-y-3">
                  <Skeleton className="h-4 w-[140px]" />
                  <Skeleton className="h-3 w-[130px]" />
                </CardContent>
              </Card>

              {/* Compliance skeleton */}
              <Card className="border-border bg-card border-l-2 border-l-muted">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Skeleton className="h-4 w-4 rounded-full" />
                      <Skeleton className="h-4 w-[130px]" />
                    </div>
                    <Skeleton className="h-3 w-[100px]" />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <Skeleton className="h-3 w-[80px]" />
                      <Skeleton className="h-3 w-[70px]" />
                    </div>
                  ))}
                  <Skeleton className="h-px w-full" />
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <Skeleton className="h-3 w-[90px]" />
                      <Skeleton className="h-3 w-[60px]" />
                    </div>
                  ))}
                  <Skeleton className="h-px w-full" />
                  {Array.from({ length: 2 }).map((_, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <Skeleton className="h-3 w-[80px]" />
                      <Skeleton className="h-3 w-[40px]" />
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Lanes skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[110px]" />
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Skeleton key={i} className="h-5 w-[60px] rounded-full" />
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* AI Insights skeleton */}
              <Card className="border-border bg-card border-l-2 border-l-accent">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[100px]" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-3 w-full mb-1.5" />
                  <Skeleton className="h-3 w-full mb-1.5" />
                  <Skeleton className="h-3 w-[60%]" />
                </CardContent>
              </Card>

              {/* Documents skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[80px]" />
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {Array.from({ length: 2 }).map((_, i) => (
                      <div key={i} className="flex items-center gap-3 p-2 rounded-md bg-secondary/30">
                        <Skeleton className="h-3.5 w-3.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <Skeleton className="h-3 w-[120px] mb-1" />
                          <Skeleton className="h-2.5 w-[50px]" />
                        </div>
                        <Skeleton className="h-5 w-[70px] rounded-full" />
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const seedNotes: ActivityNote[] = [
    { id: "cn-1", type: "phone_call", title: `Capacity check with ${carrier.contactName}`, content: `Confirmed available equipment for upcoming week. ${carrier.company} has 3 trucks available for Midwest lanes.`, timestamp: "2026-02-14T11:00:00", user: "Sarah Chen", duration: "10 min", contactPerson: carrier.contactName },
    { id: "cn-2", type: "email", title: "Insurance documentation request", content: `Requested updated COI for ${carrier.company}. Current insurance status: ${carrier.insuranceStatus}. ${carrier.insuranceStatus === "Active" ? "Renewal expected in 6 months." : "URGENT - needs immediate attention."}`, timestamp: "2026-02-12T09:30:00", user: "Marcus Johnson", contactPerson: carrier.contactName },
    { id: "cn-3", type: "internal_note", title: "Performance review note", content: `${carrier.company} current performance score: ${carrier.performanceScore}/100. On-time delivery: ${carrier.onTimePercent}%. ${carrier.performanceScore >= 90 ? "Excellent performance, consider for preferred carrier status." : carrier.performanceScore >= 80 ? "Solid performance, minor improvements needed." : "Below threshold - monitor closely and consider alternatives."}`, timestamp: "2026-02-10T16:00:00", user: "Alex Rivera" },
  ]

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-3 mb-1">
          <Link href="/carriers">
            <Button variant="ghost" size="icon" className="h-7 w-7">
              <ArrowLeft className="h-4 w-4" />
              <span className="sr-only">Back to carriers</span>
            </Button>
          </Link>
          <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg", carrier.riskFlag ? "bg-warning/10" : "bg-secondary")}>
            {carrier.riskFlag ? <AlertTriangle className="h-5 w-5 text-warning" /> : <Shield className="h-5 w-5 text-muted-foreground" />}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight text-foreground">{carrier.company}</h1>
              <StatusBadge status={carrier.insuranceStatus} />
              {carrier.riskFlag && (
                <Badge variant="outline" className="text-warning border-warning/30 text-[10px] gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  Risk Flagged
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{carrier.id} &middot; {carrier.mcNumber}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5">
              <Phone className="h-3.5 w-3.5" />
              Call
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="grid grid-cols-3 gap-6 p-6">
          {/* Left Column */}
          <div className="col-span-2 space-y-6">
            {/* KPI Cards */}
            <div className="grid grid-cols-4 gap-4">
              <Card className="border-border bg-card">
                <CardContent className="p-4">
                  <p className="text-[11px] text-muted-foreground">Performance</p>
                  <p className="text-xl font-semibold text-foreground mt-1">{carrier.performanceScore}<span className="text-sm text-muted-foreground">/100</span></p>
                </CardContent>
              </Card>
              <Card className="border-border bg-card">
                <CardContent className="p-4">
                  <p className="text-[11px] text-muted-foreground">On-time %</p>
                  <p className={cn("text-xl font-semibold mt-1", carrier.onTimePercent >= 90 ? "text-success" : carrier.onTimePercent >= 80 ? "text-warning" : "text-destructive")}>{carrier.onTimePercent}%</p>
                </CardContent>
              </Card>
              <Card className="border-border bg-card">
                <CardContent className="p-4">
                  <p className="text-[11px] text-muted-foreground">Total Loads</p>
                  <p className="text-xl font-semibold text-foreground mt-1">{carrierLoads.length}</p>
                </CardContent>
              </Card>
              <Card className="border-border bg-card">
                <CardContent className="p-4">
                  <p className="text-[11px] text-muted-foreground">Total Paid</p>
                  <p className="text-xl font-semibold text-foreground font-mono mt-1">{formatCurrency(totalPaid)}</p>
                </CardContent>
              </Card>
            </div>

            {/* Loads History */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Load History ({carrierLoads.length})</CardTitle>
              </CardHeader>
              <CardContent>
                {carrierLoads.length > 0 ? (
                  <div className="space-y-2">
                    {carrierLoads.map((l: any) => (
                      <button
                        key={l.id}
                        onClick={() => setQuickViewLoadId(l.id)}
                        className="flex items-center justify-between p-3 rounded-md bg-secondary/30 hover:bg-secondary/50 transition-colors w-full text-left cursor-pointer"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-mono font-medium text-accent">{l.id}</span>
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <MapPin className="h-3 w-3" />
                            {l.origin} to {l.destination}
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-mono text-muted-foreground">{formatCurrency(l.carrierCost)}</span>
                          <StatusBadge status={l.status} />
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground text-center py-8">No loads assigned yet.</p>
                )}
              </CardContent>
            </Card>

            {/* Activity Notes */}
            <ActivityNotes entityId={carrier.id} entityType="Carrier" initialNotes={seedNotes} />
          </div>

          {/* Right Column */}
          <div className="space-y-6">
            {/* Contact */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Contact</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm font-medium text-foreground">{carrier.contactName}</p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground"><Phone className="h-3 w-3" />{carrier.contactPhone}</div>
              </CardContent>
            </Card>

            {/* FMCSA Compliance */}
            <Card className={cn("border-border bg-card", carrier.authorityStatus !== "Active" || carrier.insuranceStatus === "Expired" ? "border-l-2 border-l-red-500" : carrier.insuranceStatus === "Expiring" || carrier.safetyRating === "Conditional" ? "border-l-2 border-l-amber-500" : "border-l-2 border-l-emerald-500")}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {carrier.authorityStatus === "Active" && carrier.insuranceStatus !== "Expired" && carrier.safetyRating !== "Unsatisfactory" ? <ShieldCheck className="h-4 w-4 text-emerald-400" /> : <ShieldX className="h-4 w-4 text-red-400" />}
                    <CardTitle className="text-sm font-medium">FMCSA Compliance</CardTitle>
                  </div>
                  <span className="text-[10px] text-muted-foreground">Last verified {new Date(carrier.lastFmcsaSync).toLocaleDateString()}</span>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">MC Number</span>
                  <span className="text-foreground font-mono">{carrier.mcNumber}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">DOT Number</span>
                  <span className="text-foreground font-mono">{carrier.dotNumber}</span>
                </div>
                <Separator className="bg-border" />
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Authority</span>
                  <Badge variant="outline" className={`text-[10px] border ${carrier.authorityStatus === "Active" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-red-500/10 text-red-400 border-red-500/20"}`}>{carrier.authorityStatus}</Badge>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Safety Rating</span>
                  <Badge variant="outline" className={`text-[10px] border ${carrier.safetyRating === "Satisfactory" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : carrier.safetyRating === "Conditional" ? "bg-amber-500/10 text-amber-400 border-amber-500/20" : carrier.safetyRating === "Unsatisfactory" ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-neutral-500/10 text-neutral-400 border-neutral-500/20"}`}>{carrier.safetyRating}</Badge>
                </div>
                <Separator className="bg-border" />
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Insurance Expiry</span>
                  <span className={cn("font-mono", (() => { const d = Math.floor((new Date(carrier.insuranceExpiry).getTime() - Date.now()) / 86400000); return d < 0 ? "text-red-400" : d < 30 ? "text-amber-400" : "text-foreground" })())}>{new Date(carrier.insuranceExpiry).toLocaleDateString()}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Liability</span>
                  <span className="font-mono text-foreground">{formatCurrency(carrier.liabilityInsurance)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Cargo</span>
                  <span className="font-mono text-foreground">{formatCurrency(carrier.cargoInsurance)}</span>
                </div>
                <Separator className="bg-border" />
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Vehicle OOS%</span>
                  <span className={cn("font-mono", carrier.vehicleOosPercent > 20 ? "text-red-400" : "text-muted-foreground")}>{carrier.vehicleOosPercent}%</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Driver OOS%</span>
                  <span className={cn("font-mono", carrier.driverOosPercent > 5.5 ? "text-amber-400" : "text-muted-foreground")}>{carrier.driverOosPercent}%</span>
                </div>
                {(carrier.authorityStatus !== "Active" || carrier.insuranceStatus === "Expired" || carrier.safetyRating === "Unsatisfactory") && (
                  <>
                    <Separator className="bg-border" />
                    <div className="flex items-center gap-1.5 p-2 rounded-md bg-red-500/10 text-red-400 text-[11px]">
                      <ShieldX className="h-3 w-3" />
                      Non-compliant -- do not dispatch
                    </div>
                  </>
                )}
                {carrier.riskFlag && carrier.authorityStatus === "Active" && carrier.insuranceStatus !== "Expired" && (
                  <>
                    <Separator className="bg-border" />
                    <div className="flex items-center gap-1.5 p-2 rounded-md bg-warning/10 text-warning text-[11px]">
                      <AlertTriangle className="h-3 w-3" />
                      Carrier flagged for risk review
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Lanes */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Lanes Covered</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-1.5">
                  {carrier.lanesCovered.map((lane) => (
                    <Badge key={lane} variant="secondary" className="text-[10px]">{lane}</Badge>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* AI Insights */}
            <Card className="border-border bg-card border-l-2 border-l-accent">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 text-accent" />
                  <CardTitle className="text-sm font-medium">AI Insights</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {carrier.riskFlag
                    ? `${carrier.company} is flagged for risk. ${carrier.insuranceStatus === "Expired" ? "Insurance has expired - suspend all operations immediately." : carrier.insuranceStatus === "Expiring" ? "Insurance expiring soon - request updated COI." : ""} Performance score of ${carrier.performanceScore}/100 and ${carrier.onTimePercent}% on-time rate are ${carrier.performanceScore < 80 ? "below acceptable thresholds. Recommend finding alternative carriers for upcoming loads." : "trending downward. Monitor closely."}`
                    : `${carrier.company} is performing well with ${carrier.performanceScore}/100 score and ${carrier.onTimePercent}% on-time delivery. ${carrierLoads.length > 0 ? `Handling ${carrierLoads.length} loads totaling ${formatCurrency(totalPaid)} in carrier pay.` : "Ready for new load assignments."} ${carrier.performanceScore >= 90 ? "Consider for preferred carrier program." : ""}`}
                </p>
              </CardContent>
            </Card>

            {/* Documents */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Documents</CardTitle>
              </CardHeader>
              <CardContent>
                {carrierDocs.length > 0 ? (
                  <div className="space-y-2">
                    {carrierDocs.map((doc: any) => (
                      <div key={doc.id} className="flex items-center gap-3 p-2 rounded-md bg-secondary/30">
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                        <div className="flex-1 min-w-0">
                          <p className="text-[11px] font-medium text-foreground truncate">{doc.name}</p>
                          <p className="text-[9px] text-muted-foreground">{doc.type}</p>
                        </div>
                        <StatusBadge status={doc.status} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground text-center py-4">No documents.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      <LoadQuickView loadId={quickViewLoadId} open={!!quickViewLoadId} onClose={() => setQuickViewLoadId(null)} />
    </div>
  )
}
