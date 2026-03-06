"use client"

import { useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Search, Plus, Download, Building2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"

import { StatusBadge } from "@/components/status-badge"
import { Progress } from "@/components/ui/progress"
import { toast } from "sonner"

type Shipper = {
  id: string
  company: string
  industry: string
  pipelineStage: string
  contractStatus: string
  annualRevenue: number
  assignedRep: string
  lastActivity: string
  conversionProbability: number
  contactName: string
  contactEmail: string
  contactPhone: string
}
import { useWorkspace } from "@/lib/workspace-context"
import { useShippers, createShipper } from "@/lib/api"

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(value)
}

const pipelineStages = ["Prospect", "Contacted", "Negotiation", "Contract Sent", "Contract Signed", "Active", "Dormant"]

function downloadCSV(data: Shipper[], filename: string) {
  const headers = ["ID", "Company", "Industry", "Pipeline Stage", "Contract Status", "Annual Revenue", "Assigned Rep", "Contact Name", "Contact Email", "Contact Phone"]
  const rows = data.map((s) => [s.id, s.company, s.industry, s.pipelineStage, s.contractStatus, s.annualRevenue, s.assignedRep, s.contactName, s.contactEmail, s.contactPhone])
  const csv = [headers.join(","), ...rows.map((r) => r.map((v) => `"${v}"`).join(","))].join("\n")
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function ShippersPage() {
  const [search, setSearch] = useState("")
  const [stageFilter, setStageFilter] = useState<string>("all")
  const [contractFilter, setContractFilter] = useState<string>("all")
  const [addOpen, setAddOpen] = useState(false)
  const { addNotification } = useWorkspace()
  const router = useRouter()

  const { data: rawShippers = [], mutate: revalidateShippers } = useShippers()

  const allShippers: Shipper[] = rawShippers.map((s: Record<string, unknown>) => ({
    id: s.id as string,
    company: s.company as string,
    industry: (s.industry || "") as string,
    pipelineStage: (s.pipeline_stage || "Prospect") as string,
    contractStatus: (s.contract_status || "Prospect") as string,
    annualRevenue: Number(s.annual_revenue) || 0,
    assignedRep: (s.assigned_rep || "") as string,
    lastActivity: (s.last_activity || s.updated_at || "") as string,
    conversionProbability: Number(s.conversion_probability) || 0,
    contactName: (s.contact_name || "") as string,
    contactEmail: (s.contact_email || "") as string,
    contactPhone: (s.contact_phone || "") as string,
  }))

  const [form, setForm] = useState({ company: "", industry: "", contactName: "", contactEmail: "", contactPhone: "", assignedRep: "" })

  const filtered = allShippers.filter((s) => {
    const matchesSearch = !search || s.company.toLowerCase().includes(search.toLowerCase()) || s.industry.toLowerCase().includes(search.toLowerCase())
    const matchesStage = stageFilter === "all" || s.pipelineStage === stageFilter
    const matchesContract = contractFilter === "all" || s.contractStatus === contractFilter
    return matchesSearch && matchesStage && matchesContract
  })

  const activeShippers = allShippers.filter((s) => s.contractStatus === "Contracted").length
  const totalRevenue = allShippers.reduce((sum, s) => sum + s.annualRevenue, 0)
  const prospects = allShippers.filter((s) => s.contractStatus === "Prospect").length

  const handleExport = useCallback(() => {
    downloadCSV(filtered, `shippers-export-${new Date().toISOString().slice(0, 10)}.csv`)
    toast.success(`Exported ${filtered.length} shippers to CSV`)
  }, [filtered])

  const handleAddShipper = useCallback(async () => {
    try {
      await createShipper({
        company: form.company,
        industry: form.industry,
        contactName: form.contactName,
        contactEmail: form.contactEmail,
        contactPhone: form.contactPhone,
      })
      addNotification({ title: `Shipper ${form.company} added`, description: `New prospect added`, type: "success", timestamp: new Date().toISOString() })
      toast.success(`${form.company} added as a new shipper`)
      revalidateShippers()
      setAddOpen(false)
      setForm({ company: "", industry: "", contactName: "", contactEmail: "", contactPhone: "", assignedRep: "" })
    } catch {
      toast.error("Failed to add shipper")
    }
  }, [form, addNotification, revalidateShippers])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Shippers</h1>
          <p className="text-xs text-muted-foreground mt-0.5">{allShippers.length} shippers &middot; {activeShippers} contracted &middot; {prospects} prospects</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={handleExport}><Download className="h-3.5 w-3.5" />Export</Button>
          <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => setAddOpen(true)}><Plus className="h-3.5 w-3.5" />Add Shipper</Button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 px-6 py-4">
        <Card className="border-border bg-card"><CardContent className="p-4"><p className="text-[11px] text-muted-foreground">Total Shippers</p><p className="text-2xl font-semibold text-card-foreground mt-1">{allShippers.length}</p></CardContent></Card>
        <Card className="border-border bg-card"><CardContent className="p-4"><p className="text-[11px] text-muted-foreground">Annual Revenue</p><p className="text-2xl font-semibold text-card-foreground mt-1 font-mono">{formatCurrency(totalRevenue)}</p></CardContent></Card>
        <Card className="border-border bg-card"><CardContent className="p-4"><p className="text-[11px] text-muted-foreground">Contracted</p><p className="text-2xl font-semibold text-success mt-1">{activeShippers}</p></CardContent></Card>
        <Card className="border-border bg-card"><CardContent className="p-4"><p className="text-[11px] text-muted-foreground">In Pipeline</p><p className="text-2xl font-semibold text-accent mt-1">{prospects}</p></CardContent></Card>
      </div>

      <div className="flex items-center gap-3 px-6 py-3 border-b border-border">
        <div className="relative flex-1 max-w-xs"><Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search shippers..." className="h-8 pl-8 text-xs bg-secondary/30" /></div>
        <Select value={stageFilter} onValueChange={setStageFilter}><SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="Pipeline Stage" /></SelectTrigger><SelectContent><SelectItem value="all">All Stages</SelectItem>{pipelineStages.map((s) => (<SelectItem key={s} value={s}>{s}</SelectItem>))}</SelectContent></Select>
        <Select value={contractFilter} onValueChange={setContractFilter}><SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="Contract Status" /></SelectTrigger><SelectContent><SelectItem value="all">All Contracts</SelectItem><SelectItem value="Contracted">Contracted</SelectItem><SelectItem value="One-off">One-off</SelectItem><SelectItem value="Prospect">Prospect</SelectItem></SelectContent></Select>
      </div>

      <div className="flex-1 overflow-auto scrollbar-thin">
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead className="text-xs">Company</TableHead><TableHead className="text-xs">Industry</TableHead><TableHead className="text-xs">Pipeline Stage</TableHead><TableHead className="text-xs">Contract</TableHead><TableHead className="text-right text-xs">Annual Revenue</TableHead><TableHead className="text-xs">Assigned Rep</TableHead><TableHead className="text-xs">Last Activity</TableHead><TableHead className="text-xs">AI Score</TableHead></TableRow></TableHeader>
          <TableBody>
            {filtered.map((shipper) => (
              <TableRow key={shipper.id} className="cursor-pointer hover:bg-secondary/30 transition-colors" onClick={() => router.push(`/shippers/${shipper.id}`)}>
                <TableCell className="py-2.5"><div className="flex items-center gap-2"><div className="flex h-7 w-7 items-center justify-center rounded-md bg-secondary text-muted-foreground"><Building2 className="h-3.5 w-3.5" /></div><span className="text-xs font-medium text-foreground">{shipper.company}</span></div></TableCell>
                <TableCell className="text-xs text-muted-foreground py-2.5">{shipper.industry}</TableCell>
                <TableCell className="py-2.5"><StatusBadge status={shipper.pipelineStage} /></TableCell>
                <TableCell className="py-2.5"><StatusBadge status={shipper.contractStatus} /></TableCell>
                <TableCell className="text-right text-xs font-mono text-foreground py-2.5">{shipper.annualRevenue > 0 ? formatCurrency(shipper.annualRevenue) : "--"}</TableCell>
                <TableCell className="text-xs text-muted-foreground py-2.5">{shipper.assignedRep}</TableCell>
                <TableCell className="text-xs text-muted-foreground py-2.5">{new Date(shipper.lastActivity).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</TableCell>
                <TableCell className="py-2.5"><div className="flex items-center gap-2"><Progress value={shipper.conversionProbability} className="h-1.5 w-12" /><span className="text-[11px] font-mono text-muted-foreground">{shipper.conversionProbability}%</span></div></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Add Shipper Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="text-base">Add New Shipper</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5"><Label className="text-xs">Company Name</Label><Input placeholder="Company name" value={form.company} onChange={(e) => setForm((p) => ({ ...p, company: e.target.value }))} className="h-9 text-sm" /></div>
            <div className="space-y-1.5"><Label className="text-xs">Industry</Label><Input placeholder="e.g., Manufacturing, Food & Beverage" value={form.industry} onChange={(e) => setForm((p) => ({ ...p, industry: e.target.value }))} className="h-9 text-sm" /></div>
            <div className="space-y-1.5"><Label className="text-xs">Contact Name</Label><Input placeholder="Full name" value={form.contactName} onChange={(e) => setForm((p) => ({ ...p, contactName: e.target.value }))} className="h-9 text-sm" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label className="text-xs">Email</Label><Input type="email" placeholder="email@company.com" value={form.contactEmail} onChange={(e) => setForm((p) => ({ ...p, contactEmail: e.target.value }))} className="h-9 text-sm" /></div>
              <div className="space-y-1.5"><Label className="text-xs">Phone</Label><Input placeholder="(555) 555-0123" value={form.contactPhone} onChange={(e) => setForm((p) => ({ ...p, contactPhone: e.target.value }))} className="h-9 text-sm" /></div>
            </div>
            <div className="space-y-1.5"><Label className="text-xs">Assigned Rep</Label><Select value={form.assignedRep} onValueChange={(v) => setForm((p) => ({ ...p, assignedRep: v }))}><SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Sarah Chen">Sarah Chen</SelectItem><SelectItem value="Marcus Johnson">Marcus Johnson</SelectItem><SelectItem value="Alex Rivera">Alex Rivera</SelectItem></SelectContent></Select></div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" className="text-xs" onClick={handleAddShipper} disabled={!form.company || !form.contactName}>Add Shipper</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
