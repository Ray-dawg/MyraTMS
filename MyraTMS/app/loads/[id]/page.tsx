"use client"

import { use, useState, useCallback, useEffect } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ArrowLeft,
  Edit,
  Upload,
  FileText,
  Phone,
  Mail,
  AlertTriangle,
  Sparkles,
  CheckCircle2,
  Circle,
  Clock,
  MapPin,
  Share2,
  Copy,
  Check,
  ExternalLink,
  Send,
  Truck,
  Loader2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { StatusBadge } from "@/components/status-badge"
import { ActivityNotes, type ActivityNote } from "@/components/activity-notes"
import { DocumentVault } from "@/components/document-vault"
import { MatchPanel } from "@/components/carrier-matching/match-panel"
import { CarrierRating } from "@/components/carrier-matching/carrier-rating"
import { useLoad, useDocuments, useShippers, useCarriers, useNotes, useDrivers, updateLoad } from "@/lib/api"
import { Skeleton } from "@/components/ui/skeleton"
import { LoadMap } from "@/components/load-map-dynamic"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

const statusSteps = ["Booked", "Dispatched", "In Transit", "Delivered", "Invoiced", "Closed"]

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(value)
}

export default function LoadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const { data: rawLoad, mutate: revalidateLoad } = useLoad(id)
  const { data: rawDocs = [] } = useDocuments({ relatedTo: id, relatedType: "Load" })
  const { data: rawShippers = [] } = useShippers()
  const { data: rawCarriers = [] } = useCarriers()
  const { data: rawNotes = [] } = useNotes("Load", id)
  const { data: rawDrivers = [] } = useDrivers(rawLoad?.carrier_id as string | undefined)

  // Map load from DB row
  const load = rawLoad ? {
    id: rawLoad.id as string,
    origin: rawLoad.origin as string,
    destination: rawLoad.destination as string,
    shipper: (rawLoad.shipper_name || "") as string,
    shipperId: (rawLoad.shipper_id || "") as string,
    carrier: (rawLoad.carrier_name || "") as string,
    carrierId: (rawLoad.carrier_id || "") as string,
    driverId: (rawLoad.driver_id || "") as string,
    driverName: (rawLoad.driver_name || "") as string,
    source: (rawLoad.source || "Load Board") as string,
    status: (rawLoad.status || "Booked") as string,
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
    originLat: rawLoad.origin_lat != null ? Number(rawLoad.origin_lat) : null,
    originLng: rawLoad.origin_lng != null ? Number(rawLoad.origin_lng) : null,
    destLat: rawLoad.dest_lat != null ? Number(rawLoad.dest_lat) : null,
    destLng: rawLoad.dest_lng != null ? Number(rawLoad.dest_lng) : null,
    currentLat: rawLoad.current_lat != null ? Number(rawLoad.current_lat) : null,
    currentLng: rawLoad.current_lng != null ? Number(rawLoad.current_lng) : null,
    podUrl: (rawLoad.pod_url || null) as string | null,
    referenceNumber: (rawLoad.reference_number || rawLoad.id || "") as string,
  } : null

  // Map drivers from DB rows
  const drivers: Array<{ id: string; name: string; phone: string; status: string; inviteStatus?: string; inviteToken?: string }> = rawDrivers.map((d: Record<string, unknown>) => ({
    id: d.id as string,
    name: (d.name || d.driver_name || `${d.first_name || ""} ${d.last_name || ""}`.trim() || "") as string,
    phone: (d.phone || d.contact_phone || "") as string,
    status: (d.status || "Available") as string,
    inviteStatus: (d.invite_status || "active") as string,
    inviteToken: (d.invite_token || "") as string,
  }))

  // Find matching shipper and carrier from lists
  const shipper = load ? rawShippers.map((s: Record<string, unknown>) => ({
    company: s.company as string,
    contactEmail: (s.contact_email || "") as string,
    contactPhone: (s.contact_phone || "") as string,
    contractStatus: (s.contract_status || "Prospect") as string,
    industry: (s.industry || "") as string,
  })).find((s: any) => s.company === load.shipper) : null

  const carrier = load ? rawCarriers.map((c: Record<string, unknown>) => ({
    company: c.company as string,
    contactName: (c.contact_name || "") as string,
    contactPhone: (c.contact_phone || "") as string,
    mcNumber: (c.mc_number || "") as string,
    insuranceStatus: (c.insurance_status || "Active") as string,
    performanceScore: Number(c.performance_score) || 85,
    onTimePercent: Number(c.on_time_percent) || 90,
    riskFlag: c.risk_flag as boolean || false,
  })).find((c: any) => c.company === load.carrier) : null

  const currentStepIndex = load ? statusSteps.indexOf(load.status) : 0

  // Map notes from DB to ActivityNote format, with fallback seed notes
  const seedNotes: ActivityNote[] = rawNotes.length > 0
    ? rawNotes.map((n: Record<string, unknown>) => ({
        id: n.id as string,
        type: (n.type || "internal_note") as string,
        title: (n.title || "") as string,
        content: (n.content || n.body || "") as string,
        timestamp: (n.created_at || n.timestamp || "") as string,
        user: (n.user || n.created_by || "") as string,
      }))
    : load ? [
        { id: "seed-call-1", type: "phone_call", title: `Check-in call - ${load.carrier}`, content: `Confirmed driver is on schedule. ETA tracking nominal. No issues reported.`, timestamp: "2026-02-13T10:15:00", user: "Sarah Chen", duration: "8 min", contactPerson: carrier?.contactName },
        { id: "seed-email-1", type: "email", title: `Rate confirmation sent to ${load.carrier}`, content: `Rate confirmation for ${load.origin} to ${load.destination}. ${formatCurrency(load.carrierCost)} carrier pay agreed.`, timestamp: "2026-02-12T09:00:00", user: "Sarah Chen", contactPerson: carrier?.contactName },
      ] as ActivityNote[] : []

  const [shareOpen, setShareOpen] = useState(false)
  const [shareLoading, setShareLoading] = useState(false)
  const [trackingUrl, setTrackingUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Driver assignment state
  const [driverAssigning, setDriverAssigning] = useState(false)

  // Tracking email state
  const [trackingEmail, setTrackingEmail] = useState("")
  const [sendingEmail, setSendingEmail] = useState(false)

  // Invoice creation state
  const [creatingInvoice, setCreatingInvoice] = useState(false)

  // Driver invite state
  const [showInviteForm, setShowInviteForm] = useState(false)
  const [inviteFirstName, setInviteFirstName] = useState("")
  const [inviteLastName, setInviteLastName] = useState("")
  const [invitePhone, setInvitePhone] = useState("")
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviting, setInviting] = useState(false)
  const [inviteResult, setInviteResult] = useState<{ inviteUrl: string; inviteToken: string; smsSent: boolean } | null>(null)
  const [inviteCopied, setInviteCopied] = useState(false)

  async function handleShareLoad() {
    if (trackingUrl) {
      setShareOpen(!shareOpen)
      return
    }
    setShareOpen(true)
    setShareLoading(true)
    try {
      const res = await fetch(`/api/loads/${id}/tracking-token`, { method: "POST" })
      if (res.ok) {
        const data = await res.json()
        setTrackingUrl(data.trackingUrl)
      }
    } catch {
      // silently fail
    } finally {
      setShareLoading(false)
    }
  }

  function handleCopy() {
    if (trackingUrl) {
      navigator.clipboard.writeText(trackingUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  // Task 2.1: Assign driver to load
  const handleAssignDriver = useCallback(async (driverId: string) => {
    setDriverAssigning(true)
    try {
      await updateLoad(id, { driverId })
      revalidateLoad()
      toast.success("Driver assigned successfully")
    } catch {
      toast.error("Failed to assign driver")
    } finally {
      setDriverAssigning(false)
    }
  }, [id, revalidateLoad])

  // Invite new driver
  const handleInviteDriver = useCallback(async () => {
    if (!inviteFirstName.trim() || !inviteLastName.trim() || !invitePhone.trim()) {
      toast.error("First name, last name, and phone are required")
      return
    }
    if (!load?.carrierId) {
      toast.error("A carrier must be assigned before inviting a driver")
      return
    }
    setInviting(true)
    try {
      const res = await fetch("/api/drivers/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          carrierId: load.carrierId,
          loadId: id,
          firstName: inviteFirstName.trim(),
          lastName: inviteLastName.trim(),
          phone: invitePhone.trim(),
          email: inviteEmail.trim() || undefined,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to invite driver")
      }
      const data = await res.json()
      setInviteResult({ inviteUrl: data.inviteUrl, inviteToken: data.inviteToken, smsSent: data.smsSent })
      revalidateLoad()
      toast.success("Driver invite created")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to invite driver")
    } finally {
      setInviting(false)
    }
  }, [id, load?.carrierId, inviteFirstName, inviteLastName, invitePhone, inviteEmail, revalidateLoad])

  // Poll invite token status to detect acceptance
  useEffect(() => {
    if (!inviteResult?.inviteToken) return
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/drivers/invite/${inviteResult.inviteToken}`)
        if (res.ok) {
          const data = await res.json()
          if (data.status === "accepted") {
            setInviteResult(null)
            setShowInviteForm(false)
            revalidateLoad()
            toast.success("Driver has accepted the invite!")
            clearInterval(interval)
          }
        }
      } catch { /* ignore polling errors */ }
    }, 30_000)
    return () => clearInterval(interval)
  }, [inviteResult?.inviteToken, revalidateLoad])

  // Task 2.2: Send tracking link via email
  const handleSendTrackingEmail = useCallback(async () => {
    if (!trackingEmail.trim()) {
      toast.error("Please enter an email address")
      return
    }
    setSendingEmail(true)
    try {
      const res = await fetch(`/api/loads/${id}/send-tracking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trackingEmail.trim(), recipientName: "" }),
      })
      if (!res.ok) throw new Error("Failed to send")
      const data = await res.json()
      if (data.success) {
        toast.success(`Tracking link sent to ${trackingEmail}`)
        setTrackingEmail("")
      } else {
        toast.error("Failed to send tracking email")
      }
    } catch {
      toast.error("Failed to send tracking email")
    } finally {
      setSendingEmail(false)
    }
  }, [id, trackingEmail])

  // Task 2.3: Create invoice from load
  const handleCreateInvoice = useCallback(async () => {
    if (!load) return
    setCreatingInvoice(true)
    try {
      const dueDate = new Date()
      dueDate.setDate(dueDate.getDate() + 30)
      const res = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loadId: load.id,
          shipperName: load.shipper,
          amount: load.revenue,
          issueDate: new Date().toISOString(),
          dueDate: dueDate.toISOString(),
          status: "Pending",
        }),
      })
      if (!res.ok) throw new Error("Failed to create invoice")
      const invoice = await res.json()
      toast.success(`Invoice ${invoice.id} created successfully`)
      router.push("/finance")
    } catch {
      toast.error("Failed to create invoice")
    } finally {
      setCreatingInvoice(false)
    }
  }, [load, router])

  if (!load) {
    return (
      <div className="flex flex-col h-full">
        {/* Header skeleton */}
        <div className="border-b border-border px-6 py-4">
          <div className="flex items-center gap-3 mb-3">
            <Skeleton className="h-7 w-7 rounded-md" />
            <Skeleton className="h-5 w-[120px]" />
            <Skeleton className="h-5 w-[70px] rounded-full" />
            <Skeleton className="h-5 w-[80px] rounded-full" />
            <div className="ml-auto flex items-center gap-2">
              <Skeleton className="h-8 w-[100px]" />
              <Skeleton className="h-8 w-[70px]" />
              <Skeleton className="h-8 w-[100px]" />
              <Skeleton className="h-8 w-[110px]" />
            </div>
          </div>
          {/* Progress bar skeleton */}
          <div className="flex items-center gap-2 mt-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center flex-1">
                <Skeleton className="h-4 w-4 rounded-full shrink-0" />
                <Skeleton className="h-3 w-[60px] ml-1.5" />
                {i < 5 && <Skeleton className="flex-1 h-px mx-2" />}
              </div>
            ))}
          </div>
        </div>

        {/* Content skeleton */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="grid grid-cols-3 gap-6 p-6">
            {/* Left Column - 2/3 */}
            <div className="col-span-2 space-y-6">
              {/* Load Overview skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[120px]" />
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-4">
                    {Array.from({ length: 3 }).map((_, col) => (
                      <div key={col} className="space-y-3">
                        <div>
                          <Skeleton className="h-3 w-[60px] mb-1.5" />
                          <Skeleton className="h-4 w-[140px]" />
                        </div>
                        <div>
                          <Skeleton className="h-3 w-[70px] mb-1.5" />
                          <Skeleton className="h-4 w-[120px]" />
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Financial Summary skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[150px]" />
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-6">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="text-center p-4 rounded-md bg-secondary/30">
                        <Skeleton className="h-3 w-[60px] mx-auto mb-2" />
                        <Skeleton className="h-6 w-[80px] mx-auto" />
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* Documents skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <Skeleton className="h-4 w-[90px]" />
                    <Skeleton className="h-7 w-[70px]" />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="flex items-center gap-3 p-2.5 rounded-md bg-secondary/30">
                        <Skeleton className="h-4 w-4 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <Skeleton className="h-3 w-[160px] mb-1" />
                          <Skeleton className="h-2.5 w-[100px]" />
                        </div>
                        <Skeleton className="h-5 w-[80px] rounded-full" />
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

            {/* Right Column - 1/3 */}
            <div className="space-y-6">
              {/* Shipper Info skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[60px]" />
                </CardHeader>
                <CardContent className="space-y-3">
                  <Skeleton className="h-4 w-[150px]" />
                  <Skeleton className="h-3 w-[180px]" />
                  <Skeleton className="h-3 w-[130px]" />
                  <Skeleton className="h-px w-full" />
                  <div className="flex items-center justify-between">
                    <Skeleton className="h-3 w-[60px]" />
                    <Skeleton className="h-5 w-[70px] rounded-full" />
                  </div>
                  <div className="flex items-center justify-between">
                    <Skeleton className="h-3 w-[60px]" />
                    <Skeleton className="h-3 w-[80px]" />
                  </div>
                </CardContent>
              </Card>

              {/* Carrier Info skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[60px]" />
                </CardHeader>
                <CardContent className="space-y-3">
                  <Skeleton className="h-4 w-[160px]" />
                  <Skeleton className="h-3 w-[130px]" />
                  <Skeleton className="h-px w-full" />
                  <div className="flex items-center justify-between">
                    <Skeleton className="h-3 w-[70px]" />
                    <Skeleton className="h-3 w-[90px]" />
                  </div>
                  <div className="flex items-center justify-between">
                    <Skeleton className="h-3 w-[60px]" />
                    <Skeleton className="h-5 w-[60px] rounded-full" />
                  </div>
                  <div className="flex items-center justify-between">
                    <Skeleton className="h-3 w-[80px]" />
                    <Skeleton className="h-3 w-[50px]" />
                  </div>
                  <div className="flex items-center justify-between">
                    <Skeleton className="h-3 w-[55px]" />
                    <Skeleton className="h-3 w-[40px]" />
                  </div>
                </CardContent>
              </Card>

              {/* AI Summary skeleton */}
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

              {/* Assigned Rep skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[100px]" />
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-8 w-8 rounded-full" />
                    <div>
                      <Skeleton className="h-4 w-[100px] mb-1" />
                      <Skeleton className="h-3 w-[110px]" />
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Driver Assignment skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[130px]" />
                </CardHeader>
                <CardContent className="space-y-3">
                  <Skeleton className="h-3 w-[90px]" />
                  <Skeleton className="h-8 w-full rounded-md" />
                </CardContent>
              </Card>

              {/* Tags skeleton */}
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <Skeleton className="h-4 w-[40px]" />
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1.5">
                    <Skeleton className="h-5 w-[50px] rounded-full" />
                    <Skeleton className="h-5 w-[70px] rounded-full" />
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-3 mb-3">
          <Link href="/loads">
            <Button variant="ghost" size="icon" className="h-7 w-7">
              <ArrowLeft className="h-4 w-4" />
              <span className="sr-only">Back to loads</span>
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">{load.id}</h1>
            {load.riskFlag && (
              <Badge variant="outline" className="text-warning border-warning/30 text-[10px] gap-1">
                <AlertTriangle className="h-3 w-3" />
                At Risk
              </Badge>
            )}
            <StatusBadge status={load.status} />
            {load.podUrl ? (
              <Badge className="bg-success/10 text-success border-success/30 text-[10px] gap-1">
                <CheckCircle2 className="h-3 w-3" />
                POD Received
              </Badge>
            ) : (load.status === "Delivered" || load.status === "Invoiced") && !load.podUrl ? (
              <Badge variant="outline" className="text-warning border-warning/30 text-[10px] gap-1">
                <Clock className="h-3 w-3" />
                Awaiting POD
              </Badge>
            ) : null}
            <StatusBadge status={load.source} />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5"
                onClick={handleShareLoad}
              >
                <Share2 className="h-3.5 w-3.5" />
                Share Load
              </Button>
              {shareOpen && (
                <div className="absolute right-0 top-full mt-2 w-80 rounded-lg border border-border bg-popover p-4 shadow-lg z-50">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-foreground">Tracking Link</p>
                    <button onClick={() => setShareOpen(false)} className="text-muted-foreground hover:text-foreground text-xs">
                      &times;
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground mb-3">
                    Share this link with your customer to let them track this shipment in real-time.
                  </p>
                  {shareLoading ? (
                    <div className="flex items-center justify-center py-3">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                      <span className="ml-2 text-xs text-muted-foreground">Generating link...</span>
                    </div>
                  ) : trackingUrl ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 rounded-md bg-secondary/50 p-2">
                        <input
                          readOnly
                          value={trackingUrl}
                          className="flex-1 bg-transparent text-xs text-foreground font-mono outline-none truncate"
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 shrink-0"
                          onClick={handleCopy}
                        >
                          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                        </Button>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-[11px] flex-1 gap-1"
                          onClick={handleCopy}
                        >
                          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                          {copied ? "Copied!" : "Copy Link"}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-[11px] flex-1 gap-1"
                          onClick={() => window.open(trackingUrl, "_blank")}
                        >
                          <ExternalLink className="h-3 w-3" />
                          Preview
                        </Button>
                      </div>
                      <Separator className="bg-border my-2" />
                      <p className="text-[11px] text-muted-foreground mb-2">
                        Email this tracking link to your customer.
                      </p>
                      <div className="flex items-center gap-2">
                        <Input
                          type="email"
                          placeholder="customer@example.com"
                          value={trackingEmail}
                          onChange={(e) => setTrackingEmail(e.target.value)}
                          className="h-7 text-xs flex-1"
                          onKeyDown={(e) => e.key === "Enter" && handleSendTrackingEmail()}
                        />
                        <Button
                          size="sm"
                          className="h-7 text-[11px] gap-1 shrink-0"
                          onClick={handleSendTrackingEmail}
                          disabled={sendingEmail || !trackingEmail.trim()}
                        >
                          {sendingEmail ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                          {sendingEmail ? "Sending..." : "Send"}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-destructive">Failed to generate link. Try again.</p>
                  )}
                </div>
              )}
            </div>
            {load.podUrl && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5 text-success border-success/30"
                onClick={() => window.open(load.podUrl!, "_blank")}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View POD
              </Button>
            )}
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5">
              <Edit className="h-3.5 w-3.5" />
              Edit
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5">
              <Upload className="h-3.5 w-3.5" />
              Upload Doc
            </Button>
            <Button size="sm" className="h-8 text-xs gap-1.5" onClick={handleCreateInvoice} disabled={creatingInvoice}>
              {creatingInvoice ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
              {creatingInvoice ? "Creating..." : "Create Invoice"}
            </Button>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="flex items-center gap-0 mt-2">
          {statusSteps.map((step, i) => {
            const isComplete = i < currentStepIndex
            const isCurrent = i === currentStepIndex
            return (
              <div key={step} className="flex items-center flex-1">
                <div className="flex items-center gap-1.5">
                  {isComplete ? (
                    <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                  ) : isCurrent ? (
                    <Clock className="h-4 w-4 text-accent shrink-0" />
                  ) : (
                    <Circle className="h-4 w-4 text-muted-foreground/30 shrink-0" />
                  )}
                  <span className={cn("text-[11px] font-medium whitespace-nowrap", isComplete ? "text-success" : isCurrent ? "text-accent" : "text-muted-foreground/40")}>{step}</span>
                </div>
                {i < statusSteps.length - 1 && (
                  <div className={cn("flex-1 h-px mx-2", i < currentStepIndex ? "bg-success" : "bg-border")} />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="grid grid-cols-3 gap-6 p-6">
          {/* Left Column - 2/3 */}
          <div className="col-span-2 space-y-6">
            <Tabs defaultValue="details" className="w-full">
              <TabsList className="h-9">
                <TabsTrigger value="details" className="text-xs">Details</TabsTrigger>
                <TabsTrigger value="documents" className="text-xs">Documents</TabsTrigger>
              </TabsList>

              <TabsContent value="details" className="space-y-6 mt-4">
            {/* Load Overview */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Load Overview</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-4">
                  <div className="space-y-3">
                    <div>
                      <p className="text-[11px] text-muted-foreground">Origin</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <MapPin className="h-3 w-3 text-muted-foreground" />
                        <p className="text-sm text-foreground">{load.origin}</p>
                      </div>
                    </div>
                    <div>
                      <p className="text-[11px] text-muted-foreground">Destination</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <MapPin className="h-3 w-3 text-accent" />
                        <p className="text-sm text-foreground">{load.destination}</p>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <p className="text-[11px] text-muted-foreground">Equipment</p>
                      <p className="text-sm text-foreground mt-0.5">{load.equipment}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-muted-foreground">Weight</p>
                      <p className="text-sm text-foreground mt-0.5">{load.weight}</p>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <p className="text-[11px] text-muted-foreground">Pickup Date</p>
                      <p className="text-sm text-foreground mt-0.5">{new Date(load.pickupDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
                    </div>
                    <div>
                      <p className="text-[11px] text-muted-foreground">Delivery Date</p>
                      <p className="text-sm text-foreground mt-0.5">{new Date(load.deliveryDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Financial Summary */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Financial Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-6">
                  <div className="text-center p-4 rounded-md bg-secondary/30">
                    <p className="text-[11px] text-muted-foreground">Revenue</p>
                    <p className="text-xl font-semibold text-foreground mt-1 font-mono">{formatCurrency(load.revenue)}</p>
                  </div>
                  <div className="text-center p-4 rounded-md bg-secondary/30">
                    <p className="text-[11px] text-muted-foreground">Carrier Pay</p>
                    <p className="text-xl font-semibold text-muted-foreground mt-1 font-mono">{formatCurrency(load.carrierCost)}</p>
                  </div>
                  <div className="text-center p-4 rounded-md bg-success/5">
                    <p className="text-[11px] text-muted-foreground">Margin</p>
                    <p className="text-xl font-semibold text-success mt-1 font-mono">{formatCurrency(load.margin)} <span className="text-sm">({load.marginPercent}%)</span></p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Activity Notes */}
            <ActivityNotes entityId={load.id} entityType="Load" initialNotes={seedNotes} />

            {/* Route Map */}
            {load.originLat != null && load.originLng != null && load.destLat != null && load.destLng != null && (
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-sm font-medium">Route Map</CardTitle>
                    {load.currentLat != null && load.currentLng != null && (
                      <Badge variant="outline" className="text-[10px] text-accent border-accent/30 gap-1">
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-75 animate-ping" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
                        </span>
                        Live Tracking
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <LoadMap
                    originLat={load.originLat}
                    originLng={load.originLng}
                    destLat={load.destLat}
                    destLng={load.destLng}
                    currentLat={load.currentLat}
                    currentLng={load.currentLng}
                    height={320}
                  />
                </CardContent>
              </Card>
            )}
              </TabsContent>

              <TabsContent value="documents" className="mt-4 space-y-4">
                {(() => {
                  const rateCon = rawDocs.find((d: Record<string, unknown>) => d.type === "Rate Confirmation")
                  if (!rateCon) return null
                  return (
                    <div className="flex items-center gap-2 p-3 rounded-lg border border-border bg-secondary/20">
                      <FileText className="h-4 w-4 text-accent shrink-0" />
                      <span className="text-xs font-medium text-foreground flex-1">Rate Confirmation generated</span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1.5"
                        onClick={() => window.open(rateCon.blob_url as string, "_blank")}
                      >
                        <FileText className="h-3 w-3" />
                        View Rate Con
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs gap-1.5"
                        onClick={() => toast.success("Rate con resend queued for carrier")}
                      >
                        <Send className="h-3 w-3" />
                        Resend to Carrier
                      </Button>
                    </div>
                  )
                })()}
                <DocumentVault loadId={load.id} />
              </TabsContent>
            </Tabs>
          </div>

          {/* Right Column - 1/3 */}
          <div className="space-y-6">
            {/* Shipper Info */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Shipper</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm font-medium text-foreground">{load.shipper}</p>
                {shipper && (
                  <>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Mail className="h-3 w-3" />{shipper.contactEmail}</div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Phone className="h-3 w-3" />{shipper.contactPhone}</div>
                    </div>
                    <Separator className="bg-border" />
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Contract</span>
                      <StatusBadge status={shipper.contractStatus} />
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Industry</span>
                      <span className="text-foreground">{shipper.industry}</span>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Carrier Info */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Carrier</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm font-medium text-foreground">{load.carrier}</p>
                {carrier && (
                  <>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Phone className="h-3 w-3" />{carrier.contactPhone}</div>
                    </div>
                    <Separator className="bg-border" />
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">MC Number</span>
                      <span className="text-foreground font-mono">{carrier.mcNumber}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Insurance</span>
                      <StatusBadge status={carrier.insuranceStatus} />
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Performance</span>
                      <span className="text-foreground font-mono">{carrier.performanceScore}/100</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">On-time</span>
                      <span className="text-foreground font-mono">{carrier.onTimePercent}%</span>
                    </div>
                    {carrier.riskFlag && (
                      <div className="flex items-center gap-1.5 p-2 rounded-md bg-warning/10 text-warning text-[11px]">
                        <AlertTriangle className="h-3 w-3" />
                        Carrier flagged for risk
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            {/* Carrier Matching Engine — show for unassigned loads */}
            {!load.carrierId && (
              <MatchPanel
                loadId={load.id}
                onAssign={(carrierId, carrierName) => {
                  revalidateLoad()
                  toast.success(`Carrier ${carrierName} assigned`)
                }}
              />
            )}

            {/* Post-delivery carrier communication rating */}
            {load.carrierId && (load.status === "Delivered" || load.status === "Invoiced") && (
              <Card className="border-border bg-card">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Rate Carrier</CardTitle>
                </CardHeader>
                <CardContent>
                  <CarrierRating
                    carrierId={load.carrierId}
                    loadId={load.id}
                  />
                </CardContent>
              </Card>
            )}

            {/* AI Summary */}
            <Card className="border-border bg-card border-l-2 border-l-accent">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-3.5 w-3.5 text-accent" />
                  <CardTitle className="text-sm font-medium">AI Summary</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {load.riskFlag
                    ? `This load has been flagged at-risk. ${load.carrier} shows declining on-time performance (${carrier?.onTimePercent}%) and ${carrier?.insuranceStatus === "Expiring" ? "insurance is expiring soon" : "has operational concerns"}. Consider proactive shipper communication and backup carrier identification.`
                    : `Load performing within expected parameters. ${load.marginPercent}% margin is ${load.marginPercent >= 25 ? "above" : "at"} target. ${load.carrier} maintaining strong performance on this lane. No immediate action required.`}
                </p>
              </CardContent>
            </Card>

            {/* Assigned Rep */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Assigned Rep</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/10 text-accent text-xs font-medium">
                    {load.assignedRep.split(" ").map((n) => n[0]).join("")}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">{load.assignedRep}</p>
                    <p className="text-[11px] text-muted-foreground">Account Manager</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Driver Assignment */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Truck className="h-3.5 w-3.5 text-muted-foreground" />
                  <CardTitle className="text-sm font-medium">Driver Assignment</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {(() => {
                  const assignedDriver = load.driverId ? drivers.find((d) => d.id === load.driverId) : null
                  const isPendingInvite = assignedDriver?.inviteStatus === "pending_invite"
                  return (
                    <>
                      {load.driverName || assignedDriver ? (
                        <div className="flex items-center gap-3">
                          <div className={cn(
                            "flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium",
                            isPendingInvite ? "bg-warning/10 text-warning" : "bg-success/10 text-success"
                          )}>
                            <Truck className="h-3.5 w-3.5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground">{load.driverName || assignedDriver?.name}</p>
                            <div className="flex items-center gap-1.5">
                              {isPendingInvite ? (
                                <Badge variant="outline" className="text-[10px] text-warning border-warning/30">Pending Invite</Badge>
                              ) : assignedDriver?.inviteStatus === "active" && assignedDriver?.inviteToken ? (
                                <Badge variant="outline" className="text-[10px] text-success border-success/30">Connected</Badge>
                              ) : (
                                <p className="text-[11px] text-muted-foreground">Currently assigned</p>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </>
                  )
                })()}
                <div className="space-y-1.5">
                  <p className="text-[11px] text-muted-foreground">{load.driverName ? "Reassign driver" : "Select a driver"}</p>
                  <Select
                    value={load.driverId || ""}
                    onValueChange={handleAssignDriver}
                    disabled={driverAssigning}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder={drivers.length > 0 ? "Choose driver..." : "No drivers available"} />
                    </SelectTrigger>
                    <SelectContent>
                      {drivers.map((driver) => (
                        <SelectItem key={driver.id} value={driver.id}>
                          <span className="text-xs">{driver.name}</span>
                          {driver.inviteStatus === "pending_invite" ? (
                            <span className="ml-2 text-[10px] text-warning">(Pending)</span>
                          ) : driver.status ? (
                            <span className={cn(
                              "ml-2 text-[10px]",
                              driver.status === "Available" ? "text-success" : "text-muted-foreground"
                            )}>
                              ({driver.status})
                            </span>
                          ) : null}
                        </SelectItem>
                      ))}
                      {drivers.length === 0 && (
                        <SelectItem value="__none" disabled>
                          <span className="text-xs text-muted-foreground">No drivers found for this carrier</span>
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                {driverAssigning && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Assigning driver...
                  </div>
                )}

                <Separator className="bg-border" />

                {/* Invite New Driver */}
                {!showInviteForm && !inviteResult && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-xs h-8"
                    onClick={() => setShowInviteForm(true)}
                    disabled={!load.carrierId}
                  >
                    Invite New Driver
                  </Button>
                )}

                {showInviteForm && !inviteResult && (
                  <div className="space-y-2 rounded-lg border border-border p-3">
                    <p className="text-[11px] font-medium text-foreground">Invite New Driver</p>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        placeholder="First Name"
                        value={inviteFirstName}
                        onChange={(e) => setInviteFirstName(e.target.value)}
                        className="h-7 text-xs"
                      />
                      <Input
                        placeholder="Last Name"
                        value={inviteLastName}
                        onChange={(e) => setInviteLastName(e.target.value)}
                        className="h-7 text-xs"
                      />
                    </div>
                    <Input
                      placeholder="Phone (required)"
                      value={invitePhone}
                      onChange={(e) => setInvitePhone(e.target.value)}
                      className="h-7 text-xs"
                    />
                    <Input
                      placeholder="Email (optional)"
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      className="h-7 text-xs"
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs flex-1"
                        onClick={() => setShowInviteForm(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        className="h-7 text-xs flex-1"
                        onClick={handleInviteDriver}
                        disabled={inviting}
                      >
                        {inviting ? (
                          <>
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            Sending...
                          </>
                        ) : (
                          "Send Invite"
                        )}
                      </Button>
                    </div>
                  </div>
                )}

                {inviteResult && (
                  <div className="space-y-2 rounded-lg border border-success/30 bg-success/5 p-3">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px] text-success border-success/30">Link Generated</Badge>
                      {inviteResult.smsSent && (
                        <Badge variant="outline" className="text-[10px] text-success border-success/30">SMS Sent</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 rounded-md bg-secondary/50 p-2">
                      <input
                        readOnly
                        value={inviteResult.inviteUrl}
                        className="flex-1 bg-transparent text-[10px] text-foreground font-mono outline-none truncate"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 shrink-0"
                        onClick={() => {
                          navigator.clipboard.writeText(inviteResult.inviteUrl)
                          setInviteCopied(true)
                          setTimeout(() => setInviteCopied(false), 2000)
                        }}
                      >
                        {inviteCopied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                      </Button>
                    </div>
                    <p className="text-[10px] text-muted-foreground">Polling for driver acceptance...</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Tags */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Tags</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary" className="text-[10px]">{load.equipment.split(" ")[0]}</Badge>
                  <Badge variant="secondary" className="text-[10px]">{load.source}</Badge>
                  {load.riskFlag && (
                    <Badge variant="outline" className="text-[10px] text-warning border-warning/30">At Risk</Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
