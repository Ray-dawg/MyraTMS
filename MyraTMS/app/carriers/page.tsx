"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Search, Plus, Download, AlertTriangle, Shield, CheckCircle2, XCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/status-badge"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"

type Carrier = {
  id: string
  company: string
  mcNumber: string
  dotNumber: string
  insuranceStatus: string
  performanceScore: number
  onTimePercent: number
  lanesCovered: string[]
  riskFlag: boolean
  contactName: string
  contactPhone: string
  authorityStatus: string
  insuranceExpiry: string
  liabilityInsurance: number
  cargoInsurance: number
  safetyRating: string
  lastFmcsaSync: string
  vehicleOosPercent: number
  driverOosPercent: number
}
import { toast } from "sonner"
import { useWorkspace } from "@/lib/workspace-context"
import { useCarriers, createCarrier } from "@/lib/api"

function downloadCSV(data: Carrier[], filename: string) {
  const headers = ["ID","Company","MC Number","Insurance","Performance","On-time %","Lanes","Contact Name","Contact Phone","Risk"]
  const rows = data.map((c) => [c.id, c.company, c.mcNumber, c.insuranceStatus, c.performanceScore, c.onTimePercent, c.lanesCovered.join("; "), c.contactName, c.contactPhone, c.riskFlag ? "Yes" : "No"])
  const csv = [headers.join(","), ...rows.map((r) => r.map((v) => `"${v}"`).join(","))].join("\n")
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function CarriersPage() {
  const [search, setSearch] = useState("")
  const [insuranceFilter, setInsuranceFilter] = useState<string>("all")
  const [addOpen, setAddOpen] = useState(false)
  const { addNotification } = useWorkspace()
  const router = useRouter()

  const { data: rawCarriers = [], mutate: revalidateCarriers } = useCarriers()

  const allCarriers: Carrier[] = rawCarriers.map((c: Record<string, unknown>) => ({
    id: c.id as string,
    company: c.company as string,
    mcNumber: (c.mc_number || "") as string,
    dotNumber: (c.dot_number || "") as string,
    insuranceStatus: (c.insurance_status || "Active") as string,
    performanceScore: Number(c.performance_score) || 85,
    onTimePercent: Number(c.on_time_percent) || 90,
    lanesCovered: (c.lanes_covered || []) as string[],
    riskFlag: c.risk_flag as boolean || false,
    contactName: (c.contact_name || "") as string,
    contactPhone: (c.contact_phone || "") as string,
    authorityStatus: (c.authority_status || "Active") as string,
    insuranceExpiry: (c.insurance_expiry || "") as string,
    liabilityInsurance: Number(c.liability_insurance) || 0,
    cargoInsurance: Number(c.cargo_insurance) || 0,
    safetyRating: (c.safety_rating || "Not Rated") as string,
    lastFmcsaSync: (c.last_fmcsa_sync || "") as string,
    vehicleOosPercent: Number(c.vehicle_oos_percent) || 0,
    driverOosPercent: Number(c.driver_oos_percent) || 0,
  }))

  const [form, setForm] = useState({ company: "", mcNumber: "", contactName: "", contactPhone: "", lanes: "" })

  // FMCSA auto-verify state
  const [fmcsaStatus, setFmcsaStatus] = useState<"idle" | "loading" | "verified" | "not_found" | "error">("idle")
  const [fmcsaData, setFmcsaData] = useState<Record<string, unknown> | null>(null)
  const fmcsaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced FMCSA verification when MC number changes
  useEffect(() => {
    // Clear any pending timer
    if (fmcsaTimerRef.current) {
      clearTimeout(fmcsaTimerRef.current)
      fmcsaTimerRef.current = null
    }

    const mc = form.mcNumber.trim()
    // Check if MC number matches expected patterns: "MC-XXXXXX" or 6+ digits
    const isValidMc = /^MC-\d+$/i.test(mc) || /^\d{6,}$/.test(mc)

    if (!isValidMc) {
      setFmcsaStatus("idle")
      setFmcsaData(null)
      return
    }

    setFmcsaStatus("loading")

    fmcsaTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/compliance/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mcNumber: mc }),
        })

        if (res.status === 404) {
          setFmcsaStatus("not_found")
          setFmcsaData(null)
          return
        }

        if (!res.ok) {
          setFmcsaStatus("error")
          setFmcsaData(null)
          return
        }

        const data = await res.json()
        setFmcsaData(data)
        setFmcsaStatus("verified")

        // Auto-fill form fields from FMCSA data
        setForm((prev) => ({
          ...prev,
          company: prev.company || (data.company as string) || prev.company,
          contactName: prev.contactName || prev.contactName,
        }))
      } catch {
        setFmcsaStatus("error")
        setFmcsaData(null)
      }
    }, 800)

    return () => {
      if (fmcsaTimerRef.current) {
        clearTimeout(fmcsaTimerRef.current)
      }
    }
  }, [form.mcNumber])

  const filtered = allCarriers.filter((c) => {
    const matchesSearch = !search || c.company.toLowerCase().includes(search.toLowerCase()) || c.mcNumber.toLowerCase().includes(search.toLowerCase())
    const matchesInsurance = insuranceFilter === "all" || c.insuranceStatus === insuranceFilter
    return matchesSearch && matchesInsurance
  })

  const avgPerformance = Math.round(allCarriers.reduce((sum, c) => sum + c.performanceScore, 0) / allCarriers.length)
  const riskCount = allCarriers.filter((c) => c.riskFlag).length

  const handleExport = useCallback(() => {
    downloadCSV(filtered, `carriers-export-${new Date().toISOString().slice(0, 10)}.csv`)
    toast.success(`Exported ${filtered.length} carriers to CSV`)
  }, [filtered])

  const handleAddCarrier = useCallback(async () => {
    try {
      await createCarrier({
        company: form.company,
        mcNumber: form.mcNumber,
        contactName: form.contactName,
        contactPhone: form.contactPhone,
        lanesCovered: form.lanes.split(",").map((l) => l.trim()).filter(Boolean),
      })
      addNotification({ title: `Carrier ${form.company} added`, description: `MC# ${form.mcNumber} added to carrier network`, type: "success", timestamp: new Date().toISOString() })
      toast.success(`${form.company} added as a new carrier`)
      revalidateCarriers()
      setAddOpen(false)
      setFmcsaStatus("idle")
      setFmcsaData(null)
      setForm({ company: "", mcNumber: "", contactName: "", contactPhone: "", lanes: "" })
    } catch {
      toast.error("Failed to add carrier")
    }
  }, [form, addNotification, revalidateCarriers])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Carriers</h1>
          <p className="text-xs text-muted-foreground mt-0.5">{allCarriers.length} carriers &middot; {riskCount} flagged</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={handleExport}><Download className="h-3.5 w-3.5" />Export</Button>
          <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => setAddOpen(true)}><Plus className="h-3.5 w-3.5" />Add Carrier</Button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 px-6 py-4">
        <Card className="border-border bg-card"><CardContent className="p-4"><p className="text-[11px] text-muted-foreground">Total Carriers</p><p className="text-2xl font-semibold text-card-foreground mt-1">{allCarriers.length}</p></CardContent></Card>
        <Card className="border-border bg-card"><CardContent className="p-4"><p className="text-[11px] text-muted-foreground">Avg Performance</p><p className="text-2xl font-semibold text-card-foreground mt-1">{avgPerformance}/100</p></CardContent></Card>
        <Card className="border-border bg-card"><CardContent className="p-4"><p className="text-[11px] text-muted-foreground">Active Insurance</p><p className="text-2xl font-semibold text-success mt-1">{allCarriers.filter((c) => c.insuranceStatus === "Active").length}</p></CardContent></Card>
        <Card className="border-border bg-card"><CardContent className="p-4"><p className="text-[11px] text-muted-foreground">Risk Flagged</p><p className="text-2xl font-semibold text-warning mt-1">{riskCount}</p></CardContent></Card>
      </div>

      <div className="flex items-center gap-3 px-6 py-3 border-b border-border">
        <div className="relative flex-1 max-w-xs"><Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search carriers or MC#..." className="h-8 pl-8 text-xs bg-secondary/30" /></div>
        <Select value={insuranceFilter} onValueChange={setInsuranceFilter}><SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="Insurance" /></SelectTrigger><SelectContent><SelectItem value="all">All Insurance</SelectItem><SelectItem value="Active">Active</SelectItem><SelectItem value="Expiring">Expiring</SelectItem><SelectItem value="Expired">Expired</SelectItem></SelectContent></Select>
      </div>

      <div className="flex-1 overflow-auto scrollbar-thin">
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead className="text-xs">Carrier</TableHead><TableHead className="text-xs">MC Number</TableHead><TableHead className="text-xs">Insurance</TableHead><TableHead className="text-xs">Authority</TableHead><TableHead className="text-xs">Performance</TableHead><TableHead className="text-xs">On-time %</TableHead><TableHead className="text-xs">Lanes</TableHead><TableHead className="text-xs">Contact</TableHead><TableHead className="text-xs w-16">Risk</TableHead></TableRow></TableHeader>
          <TableBody>
            {filtered.map((carrier) => (
              <TableRow key={carrier.id} className="cursor-pointer hover:bg-secondary/30 transition-colors" onClick={() => router.push(`/carriers/${carrier.id}`)}>
                <TableCell className="py-2.5"><div className="flex items-center gap-2"><div className={cn("flex h-7 w-7 items-center justify-center rounded-md", carrier.riskFlag ? "bg-warning/10" : "bg-secondary")}>{carrier.riskFlag ? <AlertTriangle className="h-3.5 w-3.5 text-warning" /> : <Shield className="h-3.5 w-3.5 text-muted-foreground" />}</div><span className="text-xs font-medium text-foreground">{carrier.company}</span></div></TableCell>
                <TableCell className="text-xs font-mono text-muted-foreground py-2.5">{carrier.mcNumber}</TableCell>
                <TableCell className="py-2.5"><StatusBadge status={carrier.insuranceStatus} /></TableCell>
                <TableCell className="py-2.5"><Badge variant="outline" className={`text-[9px] border ${carrier.authorityStatus === "Active" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-red-500/10 text-red-400 border-red-500/20"}`}>{carrier.authorityStatus}</Badge></TableCell>
                <TableCell className="py-2.5"><div className="flex items-center gap-2"><Progress value={carrier.performanceScore} className={cn("h-1.5 w-16", carrier.performanceScore < 80 && "[&>div]:bg-warning")} /><span className="text-[11px] font-mono text-muted-foreground">{carrier.performanceScore}</span></div></TableCell>
                <TableCell className="py-2.5"><span className={cn("text-xs font-mono", carrier.onTimePercent >= 90 ? "text-success" : carrier.onTimePercent >= 80 ? "text-warning" : "text-destructive")}>{carrier.onTimePercent}%</span></TableCell>
                <TableCell className="py-2.5"><div className="flex flex-wrap gap-1">{carrier.lanesCovered.map((lane) => (<Badge key={lane} variant="secondary" className="text-[9px] px-1.5 py-0">{lane}</Badge>))}</div></TableCell>
                <TableCell className="py-2.5"><div><p className="text-xs text-foreground">{carrier.contactName}</p><p className="text-[10px] text-muted-foreground">{carrier.contactPhone}</p></div></TableCell>
                <TableCell className="py-2.5">{carrier.riskFlag && <Badge variant="outline" className="text-[9px] text-warning border-warning/30">Risk</Badge>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={addOpen} onOpenChange={(open) => { setAddOpen(open); if (!open) { setFmcsaStatus("idle"); setFmcsaData(null) } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="text-base">Add New Carrier</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label className="text-xs">Company Name</Label><Input placeholder="Carrier name" value={form.company} onChange={(e) => setForm((p) => ({ ...p, company: e.target.value }))} className="h-9 text-sm" /></div>
              <div className="space-y-1.5">
                <Label className="text-xs">MC Number</Label>
                <div className="relative">
                  <Input placeholder="MC-XXXXXX" value={form.mcNumber} onChange={(e) => setForm((p) => ({ ...p, mcNumber: e.target.value }))} className="h-9 text-sm font-mono pr-8" />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2">
                    {fmcsaStatus === "loading" && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                    {fmcsaStatus === "verified" && <CheckCircle2 className="h-3.5 w-3.5 text-success" />}
                    {fmcsaStatus === "not_found" && <XCircle className="h-3.5 w-3.5 text-muted-foreground" />}
                    {fmcsaStatus === "error" && <XCircle className="h-3.5 w-3.5 text-destructive" />}
                  </div>
                </div>
                {fmcsaStatus === "verified" && <p className="text-[10px] text-success mt-0.5">Verified - {String(fmcsaData?.company || "")}</p>}
                {fmcsaStatus === "not_found" && <p className="text-[10px] text-muted-foreground mt-0.5">Not found in system</p>}
                {fmcsaStatus === "error" && <p className="text-[10px] text-destructive mt-0.5">Verification failed</p>}
              </div>
            </div>
            {fmcsaStatus === "verified" && fmcsaData && (
              <div className="rounded-md bg-success/5 border border-success/20 p-3 space-y-1.5">
                <p className="text-[11px] font-medium text-success">FMCSA Verification Results</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {Boolean(fmcsaData.dot_number) && <p className="text-[10px] text-muted-foreground">DOT: <span className="text-foreground font-mono">{String(fmcsaData.dot_number)}</span></p>}
                  {Boolean(fmcsaData.authority_status) && <p className="text-[10px] text-muted-foreground">Authority: <span className={cn("font-medium", fmcsaData.authority_status === "Active" ? "text-success" : "text-destructive")}>{String(fmcsaData.authority_status)}</span></p>}
                  {Boolean(fmcsaData.safety_rating) && <p className="text-[10px] text-muted-foreground">Safety: <span className="text-foreground">{String(fmcsaData.safety_rating)}</span></p>}
                  {Boolean(fmcsaData.insurance_status) && <p className="text-[10px] text-muted-foreground">Insurance: <span className={cn("font-medium", fmcsaData.insurance_status === "Active" ? "text-success" : "text-warning")}>{String(fmcsaData.insurance_status)}</span></p>}
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label className="text-xs">Contact Name</Label><Input placeholder="Full name" value={form.contactName} onChange={(e) => setForm((p) => ({ ...p, contactName: e.target.value }))} className="h-9 text-sm" /></div>
              <div className="space-y-1.5"><Label className="text-xs">Phone</Label><Input placeholder="(555) 555-0123" value={form.contactPhone} onChange={(e) => setForm((p) => ({ ...p, contactPhone: e.target.value }))} className="h-9 text-sm" /></div>
            </div>
            <div className="space-y-1.5"><Label className="text-xs">Lanes Covered</Label><Input placeholder="e.g., Midwest, Southeast (comma separated)" value={form.lanes} onChange={(e) => setForm((p) => ({ ...p, lanes: e.target.value }))} className="h-9 text-sm" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => { setAddOpen(false); setFmcsaStatus("idle"); setFmcsaData(null) }}>Cancel</Button>
            <Button size="sm" className="text-xs" onClick={handleAddCarrier} disabled={!form.company || !form.mcNumber}>Add Carrier</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
