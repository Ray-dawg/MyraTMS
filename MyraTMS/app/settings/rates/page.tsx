"use client"

import { useState } from "react"
import Link from "next/link"
import { ArrowLeft, DollarSign, Search, Plus, Upload, Trash2, Loader2 } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog"
import { useRateCache } from "@/lib/api"
import { toast } from "sonner"

function formatCurrency(v: number) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", minimumFractionDigits: 2 }).format(v)
}

function FreshnessBadge({ fetchedAt }: { fetchedAt: string }) {
  const days = (Date.now() - new Date(fetchedAt).getTime()) / 86400000
  if (days < 7) return <Badge variant="outline" className="text-[10px] border-green-300 text-green-600">Fresh</Badge>
  if (days < 30) return <Badge variant="outline" className="text-[10px] border-yellow-300 text-yellow-600">Aging</Badge>
  return <Badge variant="outline" className="text-[10px] border-red-300 text-red-600">Stale</Badge>
}

export default function RateManagementPage() {
  const [search, setSearch] = useState("")
  const [eqFilter, setEqFilter] = useState("all")
  const { data: rates, mutate, isLoading } = useRateCache({ search: search || undefined, equipmentType: eqFilter !== "all" ? eqFilter : undefined })

  const [addOpen, setAddOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  // Add rate form
  const [form, setForm] = useState({
    originRegion: "", destRegion: "", equipmentType: "dry_van", ratePerMile: "", totalRate: "", sourceNotes: "",
  })

  // Import state
  const [csvText, setCsvText] = useState("")
  const [importing, setImporting] = useState(false)

  // Stats
  const rateList = (rates as Record<string, unknown>[] | undefined) || []
  const fresh = rateList.filter((r) => (Date.now() - new Date(r.fetched_at as string).getTime()) / 86400000 < 7).length
  const aging = rateList.filter((r) => {
    const d = (Date.now() - new Date(r.fetched_at as string).getTime()) / 86400000
    return d >= 7 && d < 30
  }).length
  const stale = rateList.filter((r) => (Date.now() - new Date(r.fetched_at as string).getTime()) / 86400000 >= 30).length

  const handleAdd = async () => {
    if (!form.originRegion || !form.destRegion || !form.ratePerMile) {
      toast.error("Origin, destination, and rate per mile are required")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      })
      if (!res.ok) throw new Error("Failed to add rate")
      toast.success("Rate added")
      setAddOpen(false)
      setForm({ originRegion: "", destRegion: "", equipmentType: "dry_van", ratePerMile: "", totalRate: "", sourceNotes: "" })
      mutate()
    } catch {
      toast.error("Failed to add rate")
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/rates?id=${id}`, { method: "DELETE" })
      toast.success("Rate deleted")
      mutate()
    } catch {
      toast.error("Failed to delete rate")
    }
  }

  const handleImport = async () => {
    if (!csvText.trim()) {
      toast.error("Paste CSV data")
      return
    }
    setImporting(true)
    try {
      const lines = csvText.trim().split("\n")
      const headers = lines[0].split(",").map((h) => h.trim().toLowerCase())
      const rows = lines.slice(1).map((line) => {
        const vals = line.split(",").map((v) => v.trim())
        const obj: Record<string, string> = {}
        headers.forEach((h, i) => { obj[h] = vals[i] || "" })
        return obj
      })

      const res = await fetch("/api/rates/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      })
      const data = await res.json()
      toast.success(`Imported ${data.inserted} of ${data.total} rates`)
      if (data.errors?.length) toast.error(`${data.errors.length} errors`)
      setImportOpen(false)
      setCsvText("")
      mutate()
    } catch {
      toast.error("Import failed")
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <Button variant="ghost" size="sm" className="mb-2 -ml-2 text-xs text-muted-foreground" asChild>
          <Link href="/settings"><ArrowLeft className="h-3 w-3 mr-1" /> Settings</Link>
        </Button>
        <div className="flex items-center gap-2">
          <DollarSign className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Rate Management</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">Manage cached lane rates for the quoting engine</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Total Lanes", value: rateList.length },
          { label: "Fresh (<7d)", value: fresh, color: "text-green-600" },
          { label: "Aging (7-30d)", value: aging, color: "text-yellow-600" },
          { label: "Stale (>30d)", value: stale, color: "text-red-600" },
        ].map((m) => (
          <Card key={m.label} className="border-border bg-card">
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{m.label}</p>
              <p className={`text-lg font-bold mt-0.5 ${m.color || "text-foreground"}`}>{m.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search lanes..." className="h-9 text-sm pl-8" />
        </div>
        <Select value={eqFilter} onValueChange={setEqFilter}>
          <SelectTrigger className="h-9 text-sm w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Equipment</SelectItem>
            <SelectItem value="dry_van">Dry Van</SelectItem>
            <SelectItem value="reefer">Reefer</SelectItem>
            <SelectItem value="flatbed">Flatbed</SelectItem>
            <SelectItem value="step_deck">Step Deck</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />Add Rate
        </Button>
        <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
          <Upload className="h-3.5 w-3.5 mr-1.5" />Import CSV
        </Button>
      </div>

      {/* Table */}
      <div className="border border-border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="text-xs">Origin</TableHead>
              <TableHead className="text-xs">Destination</TableHead>
              <TableHead className="text-xs">Equipment</TableHead>
              <TableHead className="text-xs text-right">Rate/Mile</TableHead>
              <TableHead className="text-xs text-right">Total Rate</TableHead>
              <TableHead className="text-xs">Freshness</TableHead>
              <TableHead className="text-xs">Last Updated</TableHead>
              <TableHead className="text-xs w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-8">Loading...</TableCell></TableRow>
            ) : rateList.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-8">No manual rates cached</TableCell></TableRow>
            ) : (
              rateList.map((r) => (
                <TableRow key={r.id as string} className="hover:bg-muted/30">
                  <TableCell className="text-xs">{r.origin_region as string}</TableCell>
                  <TableCell className="text-xs">{r.dest_region as string}</TableCell>
                  <TableCell className="text-xs">{r.equipment_type as string}</TableCell>
                  <TableCell className="text-xs text-right font-medium">{formatCurrency(Number(r.rate_per_mile))}</TableCell>
                  <TableCell className="text-xs text-right">{r.total_rate ? formatCurrency(Number(r.total_rate)) : "—"}</TableCell>
                  <TableCell><FreshnessBadge fetchedAt={r.fetched_at as string} /></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(r.fetched_at as string).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(r.id as string)} className="h-7 w-7 p-0 text-muted-foreground hover:text-red-600">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Add Rate Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="text-sm">Add Manual Rate</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Origin Region</Label>
                <Input value={form.originRegion} onChange={(e) => setForm((f) => ({ ...f, originRegion: e.target.value }))} placeholder="e.g. Toronto" className="h-8 text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Dest Region</Label>
                <Input value={form.destRegion} onChange={(e) => setForm((f) => ({ ...f, destRegion: e.target.value }))} placeholder="e.g. Sudbury" className="h-8 text-xs" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Equipment Type</Label>
              <Select value={form.equipmentType} onValueChange={(v) => setForm((f) => ({ ...f, equipmentType: v }))}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="dry_van">Dry Van</SelectItem>
                  <SelectItem value="reefer">Reefer</SelectItem>
                  <SelectItem value="flatbed">Flatbed</SelectItem>
                  <SelectItem value="step_deck">Step Deck</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Rate/Mile (CAD)</Label>
                <Input type="number" step="0.01" value={form.ratePerMile} onChange={(e) => setForm((f) => ({ ...f, ratePerMile: e.target.value }))} className="h-8 text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Total Rate (optional)</Label>
                <Input type="number" step="0.01" value={form.totalRate} onChange={(e) => setForm((f) => ({ ...f, totalRate: e.target.value }))} className="h-8 text-xs" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Notes</Label>
              <Input value={form.sourceNotes} onChange={(e) => setForm((f) => ({ ...f, sourceNotes: e.target.value }))} placeholder="Optional notes" className="h-8 text-xs" />
            </div>
          </div>
          <DialogFooter>
            <Button size="sm" className="text-xs" onClick={handleAdd} disabled={saving}>
              {saving && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              Add Rate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import CSV Dialog */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle className="text-sm">Import Rates from CSV</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Paste CSV data with headers: origin_region, dest_region, equipment_type, rate_per_mile, total_rate
            </p>
            <textarea
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              className="w-full h-48 text-xs font-mono border border-border rounded-md p-3 bg-muted/30 resize-none"
              placeholder={"origin_region,dest_region,equipment_type,rate_per_mile,total_rate\nToronto,Sudbury,dry_van,2.85,\nToronto,Ottawa,reefer,3.25,"}
            />
          </div>
          <DialogFooter>
            <Button size="sm" className="text-xs" onClick={handleImport} disabled={importing}>
              {importing && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
