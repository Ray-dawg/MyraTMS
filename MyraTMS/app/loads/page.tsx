"use client"

import { useState, useMemo, useCallback } from "react"
import Link from "next/link"
import {
  Search,
  SlidersHorizontal,
  Download,
  Plus,
  ArrowUpDown,
  AlertTriangle,
  Rows3,
  LayoutList,
  Check,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { StatusBadge } from "@/components/status-badge"
import { cn } from "@/lib/utils"
import type { Load, LoadStatus, LoadSource } from "@/lib/types"
import { toast } from "sonner"
import { useWorkspace } from "@/lib/workspace-context"
import { useLoads, useShippers, useCarriers, createLoad } from "@/lib/api"

const statusFilters: LoadStatus[] = [
  "Booked",
  "Dispatched",
  "In Transit",
  "Delivered",
  "Invoiced",
  "Closed",
]

type SortField = "id" | "revenue" | "margin" | "pickupDate" | "status"
type SortDir = "asc" | "desc"

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(value)
}

function downloadCSV(data: Load[], filename: string) {
  const headers = ["Load ID","Origin","Destination","Shipper","Carrier","Source","Status","Revenue","Carrier Cost","Margin","Margin %","Pickup Date","Delivery Date","Rep","Equipment","Weight"]
  const rows = data.map((l) => [l.id, l.origin, l.destination, l.shipper, l.carrier, l.source, l.status, l.revenue, l.carrierCost, l.margin, l.marginPercent, l.pickupDate, l.deliveryDate, l.assignedRep, l.equipment, l.weight])
  const csv = [headers.join(","), ...rows.map((r) => r.map((v) => `"${v}"`).join(","))].join("\n")
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function LoadsPage() {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [sourceFilter, setSourceFilter] = useState<string>("all")
  const [sortField, setSortField] = useState<SortField>("id")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const [compact, setCompact] = useState(false)
  const [newLoadOpen, setNewLoadOpen] = useState(false)
  const { addNotification } = useWorkspace()

  // Real data from API
  const { data: rawLoads = [], mutate: revalidateLoads } = useLoads()
  const { data: rawShippers = [] } = useShippers()
  const { data: rawCarriers = [] } = useCarriers()

  // Map DB snake_case to our frontend interface
  const allLoads = rawLoads.map((l: Record<string, unknown>) => ({
    id: l.id as string,
    origin: l.origin as string,
    destination: l.destination as string,
    shipper: (l.shipper_name || "") as string,
    carrier: (l.carrier_name || "") as string,
    source: (l.source || "Load Board") as LoadSource,
    status: (l.status || "Booked") as LoadStatus,
    revenue: Number(l.revenue) || 0,
    carrierCost: Number(l.carrier_cost) || 0,
    margin: Number(l.margin) || 0,
    marginPercent: Number(l.margin_percent) || 0,
    pickupDate: l.pickup_date as string || "",
    deliveryDate: l.delivery_date as string || "",
    assignedRep: (l.assigned_rep || "") as string,
    equipment: (l.equipment || "") as string,
    weight: (l.weight || "") as string,
    riskFlag: l.risk_flag as boolean || false,
  }))

  const shippers = rawShippers.map((s: Record<string, unknown>) => ({ id: s.id as string, company: s.company as string }))
  const carriers = rawCarriers.map((c: Record<string, unknown>) => ({ id: c.id as string, company: c.company as string }))

  // New Load form state
  const [newLoad, setNewLoad] = useState({
    origin: "",
    destination: "",
    shipper: "",
    carrier: "",
    source: "Contract Shipper" as LoadSource,
    revenue: "",
    carrierCost: "",
    pickupDate: "",
    deliveryDate: "",
    equipment: "Dry Van 53'",
    weight: "",
  })

  // Validation errors state
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [formTouched, setFormTouched] = useState(false)

  const filteredLoads = useMemo(() => {
    let result = [...allLoads]
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(
        (l) =>
          l.id.toLowerCase().includes(q) ||
          l.origin.toLowerCase().includes(q) ||
          l.destination.toLowerCase().includes(q) ||
          l.shipper.toLowerCase().includes(q) ||
          l.carrier.toLowerCase().includes(q)
      )
    }
    if (statusFilter !== "all") result = result.filter((l) => l.status === statusFilter)
    if (sourceFilter !== "all") result = result.filter((l) => l.source === sourceFilter)
    result.sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1
      switch (sortField) {
        case "revenue": return (a.revenue - b.revenue) * dir
        case "margin": return (a.marginPercent - b.marginPercent) * dir
        case "pickupDate": return (new Date(a.pickupDate).getTime() - new Date(b.pickupDate).getTime()) * dir
        case "status": return a.status.localeCompare(b.status) * dir
        default: return a.id.localeCompare(b.id) * dir
      }
    })
    return result
  }, [allLoads, search, statusFilter, sourceFilter, sortField, sortDir])

  const toggleSort = (field: SortField) => {
    if (sortField === field) setSortDir(sortDir === "asc" ? "desc" : "asc")
    else { setSortField(field); setSortDir("desc") }
  }

  const toggleAll = () => {
    if (selectedRows.size === filteredLoads.length) setSelectedRows(new Set())
    else setSelectedRows(new Set(filteredLoads.map((l) => l.id)))
  }

  const toggleRow = (id: string) => {
    const next = new Set(selectedRows)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedRows(next)
  }

  const handleExport = useCallback(() => {
    const data = selectedRows.size > 0 ? filteredLoads.filter((l) => selectedRows.has(l.id)) : filteredLoads
    downloadCSV(data, `loads-export-${new Date().toISOString().slice(0, 10)}.csv`)
    toast.success(`Exported ${data.length} loads to CSV`)
  }, [filteredLoads, selectedRows])

  const validateForm = useCallback(() => {
    const errors: Record<string, string> = {}
    if (!newLoad.origin.trim()) errors.origin = "Origin is required"
    if (!newLoad.destination.trim()) errors.destination = "Destination is required"
    if (!newLoad.shipper) errors.shipper = "Shipper is required"
    return errors
  }, [newLoad])

  const handleCreateLoad = useCallback(async () => {
    setFormTouched(true)
    const errors = validateForm()
    setFormErrors(errors)
    if (Object.keys(errors).length > 0) {
      toast.error("Please fill in all required fields")
      return
    }

    const revenue = parseFloat(newLoad.revenue) || 0
    const cost = parseFloat(newLoad.carrierCost) || 0
    try {
      const result = await createLoad({
        origin: newLoad.origin,
        destination: newLoad.destination,
        shipperName: newLoad.shipper,
        carrierName: newLoad.carrier,
        source: newLoad.source,
        revenue,
        carrierCost: cost,
        pickupDate: newLoad.pickupDate || null,
        deliveryDate: newLoad.deliveryDate || null,
        equipment: newLoad.equipment,
        weight: newLoad.weight || "0 lbs",
      })
      addNotification({ title: `Load ${result.id} created`, description: `${newLoad.origin} to ${newLoad.destination} - ${formatCurrency(revenue)}`, type: "success", timestamp: new Date().toISOString() })
      toast.success(`Load ${result.id} created successfully`)
      revalidateLoads()
      setNewLoadOpen(false)
      setFormErrors({})
      setFormTouched(false)
      setNewLoad({ origin: "", destination: "", shipper: "", carrier: "", source: "Contract Shipper", revenue: "", carrierCost: "", pickupDate: "", deliveryDate: "", equipment: "Dry Van 53'", weight: "" })
    } catch {
      toast.error("Failed to create load")
    }
  }, [newLoad, addNotification, revalidateLoads, validateForm])

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Loads</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {filteredLoads.length} loads &middot; {allLoads.filter((l: any) => l.status === "In Transit").length} in transit
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={handleExport}>
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
          <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => setNewLoadOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            New Load
          </Button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search loads..." className="h-8 pl-8 text-xs bg-secondary/30" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {statusFilters.map((s) => (<SelectItem key={s} value={s}>{s}</SelectItem>))}
          </SelectContent>
        </Select>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="Source" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sources</SelectItem>
            <SelectItem value="Load Board">Load Board</SelectItem>
            <SelectItem value="Contract Shipper">Contract Shipper</SelectItem>
            <SelectItem value="One-off Shipper">One-off Shipper</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-1">
          {selectedRows.size > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 text-xs">{selectedRows.size} selected</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel className="text-xs">Bulk Actions</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-xs" onClick={() => toast.info("Status update dialog coming soon")}>Update Status</DropdownMenuItem>
                <DropdownMenuItem className="text-xs" onClick={() => toast.info("Rep assignment coming soon")}>Assign Rep</DropdownMenuItem>
                <DropdownMenuItem className="text-xs" onClick={handleExport}>Export Selected</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8"><SlidersHorizontal className="h-3.5 w-3.5" /><span className="sr-only">Table settings</span></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs">Saved Views</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-xs gap-2"><Check className="h-3 w-3" /> Default View</DropdownMenuItem>
              <DropdownMenuItem className="text-xs gap-2"><span className="w-3" /> At-Risk Loads</DropdownMenuItem>
              <DropdownMenuItem className="text-xs gap-2"><span className="w-3" /> High Margin</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCompact(!compact)}>
            {compact ? <LayoutList className="h-3.5 w-3.5" /> : <Rows3 className="h-3.5 w-3.5" />}
            <span className="sr-only">Toggle density</span>
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto scrollbar-thin">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10"><Checkbox checked={selectedRows.size === filteredLoads.length && filteredLoads.length > 0} onCheckedChange={toggleAll} aria-label="Select all" /></TableHead>
              <TableHead className="w-24"><button onClick={() => toggleSort("id")} className="flex items-center gap-1 text-xs">Load ID<ArrowUpDown className="h-3 w-3" /></button></TableHead>
              <TableHead className="text-xs">Origin</TableHead>
              <TableHead className="text-xs">Destination</TableHead>
              <TableHead className="text-xs">Shipper</TableHead>
              <TableHead className="text-xs">Carrier</TableHead>
              <TableHead className="text-xs">Source</TableHead>
              <TableHead><button onClick={() => toggleSort("status")} className="flex items-center gap-1 text-xs">Status<ArrowUpDown className="h-3 w-3" /></button></TableHead>
              <TableHead className="text-right"><button onClick={() => toggleSort("revenue")} className="flex items-center gap-1 text-xs ml-auto">Revenue<ArrowUpDown className="h-3 w-3" /></button></TableHead>
              <TableHead className="text-right text-xs">Cost</TableHead>
              <TableHead className="text-right"><button onClick={() => toggleSort("margin")} className="flex items-center gap-1 text-xs ml-auto">Margin<ArrowUpDown className="h-3 w-3" /></button></TableHead>
              <TableHead><button onClick={() => toggleSort("pickupDate")} className="flex items-center gap-1 text-xs">Pickup<ArrowUpDown className="h-3 w-3" /></button></TableHead>
              <TableHead className="text-xs">Rep</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredLoads.map((load) => (
              <TableRow key={load.id} className={cn("group transition-colors", selectedRows.has(load.id) && "bg-accent/5")}>
                <TableCell className={compact ? "py-1.5" : "py-2.5"}><Checkbox checked={selectedRows.has(load.id)} onCheckedChange={() => toggleRow(load.id)} aria-label={`Select ${load.id}`} /></TableCell>
                <TableCell className={compact ? "py-1.5" : "py-2.5"}>
                  <Link href={`/loads/${load.id}`} className="text-xs font-medium text-foreground hover:text-accent transition-colors flex items-center gap-1.5">
                    {load.riskFlag && <AlertTriangle className="h-3 w-3 text-warning" />}
                    {load.id}
                  </Link>
                </TableCell>
                <TableCell className={cn("text-xs text-muted-foreground", compact ? "py-1.5" : "py-2.5")}>{load.origin}</TableCell>
                <TableCell className={cn("text-xs text-muted-foreground", compact ? "py-1.5" : "py-2.5")}>{load.destination}</TableCell>
                <TableCell className={cn("text-xs text-foreground", compact ? "py-1.5" : "py-2.5")}>{load.shipper}</TableCell>
                <TableCell className={cn("text-xs text-muted-foreground", compact ? "py-1.5" : "py-2.5")}>{load.carrier}</TableCell>
                <TableCell className={cn("text-xs text-muted-foreground", compact ? "py-1.5" : "py-2.5")}>{load.source}</TableCell>
                <TableCell className={compact ? "py-1.5" : "py-2.5"}><StatusBadge status={load.status} /></TableCell>
                <TableCell className={cn("text-right text-xs font-medium text-foreground font-mono", compact ? "py-1.5" : "py-2.5")}>{formatCurrency(load.revenue)}</TableCell>
                <TableCell className={cn("text-right text-xs text-muted-foreground font-mono", compact ? "py-1.5" : "py-2.5")}>{formatCurrency(load.carrierCost)}</TableCell>
                <TableCell className={cn("text-right", compact ? "py-1.5" : "py-2.5")}>
                  <span className="text-xs font-medium text-success font-mono">{formatCurrency(load.margin)}</span>
                  <span className="text-[10px] text-muted-foreground ml-1">{load.marginPercent}%</span>
                </TableCell>
                <TableCell className={cn("text-xs text-muted-foreground", compact ? "py-1.5" : "py-2.5")}>
                  {new Date(load.pickupDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </TableCell>
                <TableCell className={cn("text-xs text-muted-foreground", compact ? "py-1.5" : "py-2.5")}>{load.assignedRep.split(" ")[0]}</TableCell>
                <TableCell className={compact ? "py-1.5" : "py-2.5"} />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* New Load Dialog */}
      <Dialog open={newLoadOpen} onOpenChange={setNewLoadOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base">Create New Load</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Origin <span className="text-destructive">*</span></Label>
                <Input
                  placeholder="City, State"
                  value={newLoad.origin}
                  onChange={(e) => {
                    setNewLoad((p) => ({ ...p, origin: e.target.value }))
                    if (formTouched) setFormErrors((prev) => { const next = { ...prev }; if (e.target.value.trim()) delete next.origin; else next.origin = "Origin is required"; return next })
                  }}
                  className={cn("h-9 text-sm", formErrors.origin && "border-destructive")}
                  aria-invalid={!!formErrors.origin}
                />
                {formErrors.origin && <p className="text-[11px] text-destructive">{formErrors.origin}</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Destination <span className="text-destructive">*</span></Label>
                <Input
                  placeholder="City, State"
                  value={newLoad.destination}
                  onChange={(e) => {
                    setNewLoad((p) => ({ ...p, destination: e.target.value }))
                    if (formTouched) setFormErrors((prev) => { const next = { ...prev }; if (e.target.value.trim()) delete next.destination; else next.destination = "Destination is required"; return next })
                  }}
                  className={cn("h-9 text-sm", formErrors.destination && "border-destructive")}
                  aria-invalid={!!formErrors.destination}
                />
                {formErrors.destination && <p className="text-[11px] text-destructive">{formErrors.destination}</p>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Shipper <span className="text-destructive">*</span></Label>
                <Select value={newLoad.shipper} onValueChange={(v) => {
                  setNewLoad((p) => ({ ...p, shipper: v }))
                  if (formTouched) setFormErrors((prev) => { const next = { ...prev }; if (v) delete next.shipper; else next.shipper = "Shipper is required"; return next })
                }}>
                  <SelectTrigger className={cn("h-9 text-sm", formErrors.shipper && "border-destructive")} aria-invalid={!!formErrors.shipper}><SelectValue placeholder="Select shipper" /></SelectTrigger>
                  <SelectContent>{shippers.map((s: any) => <SelectItem key={s.id} value={s.company}>{s.company}</SelectItem>)}</SelectContent>
                </Select>
                {formErrors.shipper && <p className="text-[11px] text-destructive">{formErrors.shipper}</p>}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Carrier</Label>
                <Select value={newLoad.carrier} onValueChange={(v) => setNewLoad((p) => ({ ...p, carrier: v }))}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select carrier" /></SelectTrigger>
                  <SelectContent>{carriers.map((c: any) => <SelectItem key={c.id} value={c.company}>{c.company}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Source</Label>
                <Select value={newLoad.source} onValueChange={(v) => setNewLoad((p) => ({ ...p, source: v as LoadSource }))}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Contract Shipper">Contract Shipper</SelectItem>
                    <SelectItem value="Load Board">Load Board</SelectItem>
                    <SelectItem value="One-off Shipper">One-off Shipper</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Revenue ($)</Label>
                <Input type="number" placeholder="0" value={newLoad.revenue} onChange={(e) => setNewLoad((p) => ({ ...p, revenue: e.target.value }))} className="h-9 text-sm font-mono" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Carrier Cost ($)</Label>
                <Input type="number" placeholder="0" value={newLoad.carrierCost} onChange={(e) => setNewLoad((p) => ({ ...p, carrierCost: e.target.value }))} className="h-9 text-sm font-mono" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Pickup Date</Label>
                <Input type="date" value={newLoad.pickupDate} onChange={(e) => setNewLoad((p) => ({ ...p, pickupDate: e.target.value }))} className="h-9 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Delivery Date</Label>
                <Input type="date" value={newLoad.deliveryDate} onChange={(e) => setNewLoad((p) => ({ ...p, deliveryDate: e.target.value }))} className="h-9 text-sm" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Equipment</Label>
                <Select value={newLoad.equipment} onValueChange={(v) => setNewLoad((p) => ({ ...p, equipment: v }))}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Dry Van 53'">{"Dry Van 53'"}</SelectItem>
                    <SelectItem value="Dry Van 26'">{"Dry Van 26'"}</SelectItem>
                    <SelectItem value="Reefer 53'">{"Reefer 53'"}</SelectItem>
                    <SelectItem value="Flatbed 48'">{"Flatbed 48'"}</SelectItem>
                    <SelectItem value="Tanker">Tanker</SelectItem>
                    <SelectItem value="Hopper">Hopper</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Weight</Label>
                <Input placeholder="e.g., 42,000 lbs" value={newLoad.weight} onChange={(e) => setNewLoad((p) => ({ ...p, weight: e.target.value }))} className="h-9 text-sm" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => { setNewLoadOpen(false); setFormErrors({}); setFormTouched(false) }}>Cancel</Button>
            <Button size="sm" className="text-xs" onClick={handleCreateLoad}>Create Load</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
