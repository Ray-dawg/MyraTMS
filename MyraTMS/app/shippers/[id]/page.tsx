"use client"

import { use } from "react"
import Link from "next/link"
import { ArrowLeft, Building2, Mail, Phone, MapPin, DollarSign, TrendingUp, FileText, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/status-badge"
import { ActivityNotes, type ActivityNote } from "@/components/activity-notes"
import { LoadQuickView } from "@/components/load-quick-view"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { useShipper, useLoads, useDocuments, useInvoices } from "@/lib/api"
import { useState } from "react"

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(value)
}

export default function ShipperDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [quickViewLoadId, setQuickViewLoadId] = useState<string | null>(null)

  const { data: rawShipper } = useShipper(id)
  const { data: rawLoads = [] } = useLoads()
  const { data: rawDocs = [] } = useDocuments({ relatedTo: id, relatedType: "Shipper" })
  const { data: rawInvoices = [] } = useInvoices()

  // Map shipper from DB row
  const shipper = rawShipper ? {
    id: rawShipper.id as string,
    company: rawShipper.company as string,
    industry: (rawShipper.industry || "") as string,
    pipelineStage: (rawShipper.pipeline_stage || "Prospect") as string,
    contractStatus: (rawShipper.contract_status || "Prospect") as string,
    annualRevenue: Number(rawShipper.annual_revenue) || 0,
    assignedRep: (rawShipper.assigned_rep || "") as string,
    lastActivity: (rawShipper.last_activity || rawShipper.updated_at || "") as string,
    conversionProbability: Number(rawShipper.conversion_probability) || 0,
    contactName: (rawShipper.contact_name || "") as string,
    contactEmail: (rawShipper.contact_email || "") as string,
    contactPhone: (rawShipper.contact_phone || "") as string,
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
  const shipperLoads = shipper ? allLoads.filter((l: any) => l.shipper === shipper.company) : []

  // Map documents from DB rows
  const shipperDocs = rawDocs.map((d: Record<string, unknown>) => ({
    id: d.id as string,
    name: d.name as string,
    type: (d.type || "BOL") as string,
    relatedTo: (d.related_to || "") as string,
    status: (d.status || "Pending Review") as string,
  }))

  // Map invoices from DB rows
  const allInvoices = rawInvoices.map((inv: Record<string, unknown>) => ({
    id: inv.id as string,
    loadId: (inv.load_id || "") as string,
    shipper: (inv.shipper || inv.shipper_name || "") as string,
    amount: Number(inv.amount) || 0,
    status: (inv.status || "Pending") as string,
  }))
  const shipperInvoices = shipper ? allInvoices.filter((inv: any) => inv.shipper === shipper.company) : []

  const totalRevenue = shipperLoads.reduce((sum: number, l: any) => sum + l.revenue, 0)
  const totalMargin = shipperLoads.reduce((sum: number, l: any) => sum + l.margin, 0)
  const avgMarginPercent = shipperLoads.length > 0 ? Math.round(shipperLoads.reduce((sum: number, l: any) => sum + l.marginPercent, 0) / shipperLoads.length) : 0

  if (!shipper) {
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
                <Skeleton className="h-5 w-[70px] rounded-full" />
                <Skeleton className="h-5 w-[60px] rounded-full" />
              </div>
              <Skeleton className="h-3 w-[150px] mt-1" />
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Skeleton className="h-8 w-[70px]" />
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
                      <Skeleton className="h-3 w-[80px] mb-2" />
                      <Skeleton className="h-6 w-[70px]" />
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
                          <Skeleton className="h-3.5 w-[30px]" />
                          <Skeleton className="h-5 w-[70px] rounded-full" />
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Invoices skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[100px]" />
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="flex items-center justify-between p-3 rounded-md bg-secondary/30">
                        <div className="flex items-center gap-3">
                          <Skeleton className="h-3.5 w-[70px]" />
                          <Skeleton className="h-3.5 w-[70px]" />
                        </div>
                        <div className="flex items-center gap-3">
                          <Skeleton className="h-3.5 w-[60px]" />
                          <Skeleton className="h-5 w-[60px] rounded-full" />
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
              {/* Contact Info skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[110px]" />
                </CardHeader>
                <CardContent className="space-y-3">
                  <Skeleton className="h-4 w-[140px]" />
                  <Skeleton className="h-3 w-[180px]" />
                  <Skeleton className="h-3 w-[130px]" />
                </CardContent>
              </Card>

              {/* Business Details skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[120px]" />
                </CardHeader>
                <CardContent className="space-y-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i}>
                      <div className="flex items-center justify-between">
                        <Skeleton className="h-3 w-[80px]" />
                        <Skeleton className="h-3 w-[90px]" />
                      </div>
                      {i === 0 && <Skeleton className="h-px w-full mt-3" />}
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Conversion Score skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[140px]" />
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-2 flex-1 rounded-full" />
                    <Skeleton className="h-4 w-[35px]" />
                  </div>
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-[80%]" />
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
    { id: "sn-1", type: "phone_call", title: `Quarterly review call with ${shipper.contactName}`, content: `Discussed volume projections for Q2. ${shipper.company} looking to increase shipment frequency. Agreed to revisit pricing next month.`, timestamp: "2026-02-14T14:30:00", user: "Sarah Chen", duration: "25 min", contactPerson: shipper.contactName },
    { id: "sn-2", type: "email", title: "Contract renewal discussion", content: `Sent updated contract terms for review. Key changes: volume discount tier adjustment and lane expansion to include Southeast.`, timestamp: "2026-02-12T10:00:00", user: "Sarah Chen", contactPerson: shipper.contactName },
    { id: "sn-3", type: "zoom_meeting", title: "Operations alignment meeting", content: `Reviewed pickup scheduling process and dock hours. ${shipper.company} will provide 48hr advance notice for all pickups going forward.`, timestamp: "2026-02-10T15:00:00", user: "Marcus Johnson", duration: "45 min", contactPerson: shipper.contactName },
    { id: "sn-4", type: "field_visit", title: `Site visit - ${shipper.company} warehouse`, content: `Inspected loading dock facilities. Good condition, 4 dock doors available. Average load time ~2 hours. No detention issues observed.`, timestamp: "2026-02-05T09:00:00", user: "Alex Rivera", duration: "1.5 hrs" },
  ]

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-3 mb-1">
          <Link href="/shippers">
            <Button variant="ghost" size="icon" className="h-7 w-7">
              <ArrowLeft className="h-4 w-4" />
              <span className="sr-only">Back to shippers</span>
            </Button>
          </Link>
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
            <Building2 className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight text-foreground">{shipper.company}</h1>
              <StatusBadge status={shipper.contractStatus} />
              <StatusBadge status={shipper.pipelineStage} />
            </div>
            <p className="text-xs text-muted-foreground">{shipper.id} &middot; {shipper.industry}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              Email
            </Button>
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
                  <p className="text-[11px] text-muted-foreground">Total Revenue</p>
                  <p className="text-xl font-semibold text-foreground font-mono mt-1">{formatCurrency(totalRevenue)}</p>
                </CardContent>
              </Card>
              <Card className="border-border bg-card">
                <CardContent className="p-4">
                  <p className="text-[11px] text-muted-foreground">Total Margin</p>
                  <p className="text-xl font-semibold text-success font-mono mt-1">{formatCurrency(totalMargin)}</p>
                </CardContent>
              </Card>
              <Card className="border-border bg-card">
                <CardContent className="p-4">
                  <p className="text-[11px] text-muted-foreground">Avg Margin %</p>
                  <p className="text-xl font-semibold text-foreground mt-1">{avgMarginPercent}%</p>
                </CardContent>
              </Card>
              <Card className="border-border bg-card">
                <CardContent className="p-4">
                  <p className="text-[11px] text-muted-foreground">Total Loads</p>
                  <p className="text-xl font-semibold text-foreground mt-1">{shipperLoads.length}</p>
                </CardContent>
              </Card>
            </div>

            {/* Loads History */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Load History ({shipperLoads.length})</CardTitle>
              </CardHeader>
              <CardContent>
                {shipperLoads.length > 0 ? (
                  <div className="space-y-2">
                    {shipperLoads.map((l: any) => (
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
                          <span className="text-xs font-mono font-medium text-foreground">{formatCurrency(l.revenue)}</span>
                          <span className="text-[10px] text-success font-mono">{l.marginPercent}%</span>
                          <StatusBadge status={l.status} />
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground text-center py-8">No loads associated yet.</p>
                )}
              </CardContent>
            </Card>

            {/* Invoices */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Invoices ({shipperInvoices.length})</CardTitle>
              </CardHeader>
              <CardContent>
                {shipperInvoices.length > 0 ? (
                  <div className="space-y-2">
                    {shipperInvoices.map((inv: any) => (
                      <div key={inv.id} className="flex items-center justify-between p-3 rounded-md bg-secondary/30">
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-mono font-medium text-foreground">{inv.id}</span>
                          <button onClick={() => setQuickViewLoadId(inv.loadId)} className="text-xs text-accent font-mono hover:underline cursor-pointer">{inv.loadId}</button>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-mono text-foreground">{formatCurrency(inv.amount)}</span>
                          <StatusBadge status={inv.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground text-center py-8">No invoices.</p>
                )}
              </CardContent>
            </Card>

            {/* Activity Notes */}
            <ActivityNotes entityId={shipper.id} entityType="Shipper" initialNotes={seedNotes} />
          </div>

          {/* Right Column */}
          <div className="space-y-6">
            {/* Contact Info */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Primary Contact</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm font-medium text-foreground">{shipper.contactName}</p>
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground"><Mail className="h-3 w-3" />{shipper.contactEmail}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground"><Phone className="h-3 w-3" />{shipper.contactPhone}</div>
                </div>
              </CardContent>
            </Card>

            {/* Business Details */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Business Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Industry</span>
                  <span className="text-foreground">{shipper.industry}</span>
                </div>
                <Separator className="bg-border" />
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Contract Status</span>
                  <StatusBadge status={shipper.contractStatus} />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Pipeline Stage</span>
                  <StatusBadge status={shipper.pipelineStage} />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Annual Revenue</span>
                  <span className="text-foreground font-mono">{shipper.annualRevenue > 0 ? formatCurrency(shipper.annualRevenue) : "--"}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Assigned Rep</span>
                  <span className="text-foreground">{shipper.assignedRep}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Last Activity</span>
                  <span className="text-foreground">{new Date(shipper.lastActivity).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                </div>
              </CardContent>
            </Card>

            {/* Conversion Score */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">AI Conversion Score</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-3">
                  <Progress value={shipper.conversionProbability} className="h-2 flex-1" />
                  <span className="text-sm font-semibold font-mono text-foreground">{shipper.conversionProbability}%</span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {shipper.conversionProbability >= 80
                    ? "Strong account with consistent volume and reliable payment history."
                    : shipper.conversionProbability >= 50
                    ? "Good potential. Regular follow-ups and competitive pricing should convert."
                    : "Needs nurturing. Consider value-add content and competitive lane analysis."}
                </p>
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
                  {shipper.contractStatus === "Contracted"
                    ? `${shipper.company} is a stable contracted shipper generating ${formatCurrency(totalRevenue)} in revenue across ${shipperLoads.length} loads. Average margin of ${avgMarginPercent}% is ${avgMarginPercent >= 22 ? "healthy" : "below target"}. Consider negotiating volume discounts to secure long-term partnership.`
                    : `${shipper.company} shows ${shipper.conversionProbability}% conversion probability. ${shipper.conversionProbability > 60 ? "High potential - recommend prioritizing outreach and scheduling a site visit." : "Needs consistent touchpoints - suggest weekly check-ins and lane analysis presentations."}`}
                </p>
              </CardContent>
            </Card>

            {/* Documents */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Documents</CardTitle>
              </CardHeader>
              <CardContent>
                {shipperDocs.length > 0 ? (
                  <div className="space-y-2">
                    {shipperDocs.map((doc: any) => (
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
