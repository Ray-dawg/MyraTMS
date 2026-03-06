"use client"

import { useState, useCallback, useMemo } from "react"
import { Plus, BarChart3, Download, Trash2, Eye, FileText, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { useLoads, useInvoices, useShippers, useCarriers } from "@/lib/api"
import { toast } from "sonner"
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip,
} from "recharts"

interface CustomReport {
  id: string
  name: string
  dataSource: string
  columns: string[]
  dateRange: string
  createdAt: string
}

const dataSources = [
  { value: "loads", label: "Loads", columns: ["Load ID", "Origin", "Destination", "Shipper", "Carrier", "Status", "Revenue", "Carrier Cost", "Margin", "Margin %", "Pickup Date", "Rep"] },
  { value: "invoices", label: "Invoices", columns: ["Invoice ID", "Load ID", "Shipper", "Amount", "Status", "Issue Date", "Due Date", "Days Outstanding"] },
  { value: "shippers", label: "Shippers", columns: ["Company", "Industry", "Pipeline Stage", "Contract Status", "Annual Revenue", "Rep", "AI Score"] },
  { value: "carriers", label: "Carriers", columns: ["Company", "MC Number", "Insurance", "Performance", "On-time %", "Lanes", "Risk Flag"] },
]

const dateRanges = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "90d", label: "Last 90 Days" },
  { value: "ytd", label: "Year to Date" },
  { value: "all", label: "All Time" },
]

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(value)
}

function CustomBarTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload || !payload.length) return null
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 shadow-md">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: entry.color }} />
          <span className="text-popover-foreground">{entry.name}:</span>
          <span className="font-medium text-popover-foreground font-mono">{typeof entry.value === "number" && entry.value > 100 ? formatCurrency(entry.value) : entry.value}</span>
        </div>
      ))}
    </div>
  )
}

function generateCSV(headers: string[], rows: (string | number)[][]): string {
  return [headers.join(","), ...rows.map((r) => r.map((v) => `"${v}"`).join(","))].join("\n")
}

function downloadCSV(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const prebuiltReports: CustomReport[] = [
  { id: "R-001", name: "Weekly Load Summary", dataSource: "loads", columns: ["Load ID", "Origin", "Destination", "Status", "Revenue", "Margin"], dateRange: "7d", createdAt: "2026-02-10" },
  { id: "R-002", name: "Overdue Invoice Report", dataSource: "invoices", columns: ["Invoice ID", "Load ID", "Shipper", "Amount", "Status", "Days Outstanding"], dateRange: "30d", createdAt: "2026-02-08" },
  { id: "R-003", name: "Carrier Performance Scorecard", dataSource: "carriers", columns: ["Company", "Performance", "On-time %", "Insurance", "Risk Flag"], dateRange: "90d", createdAt: "2026-02-05" },
]

export default function ReportsPage() {
  const { data: rawLoads = [], isLoading: loadsLoading } = useLoads()
  const { data: rawInvoices = [], isLoading: invoicesLoading } = useInvoices()
  const { data: rawShippers = [], isLoading: shippersLoading } = useShippers()
  const { data: rawCarriers = [], isLoading: carriersLoading } = useCarriers()

  const isLoading = loadsLoading || invoicesLoading || shippersLoading || carriersLoading

  // Map raw DB data to friendly shapes
  const loads = useMemo(() => rawLoads.map((l: Record<string, unknown>) => ({
    id: l.id as string,
    origin: (l.origin || "") as string,
    destination: (l.destination || "") as string,
    shipper: (l.shipper_name || "") as string,
    carrier: (l.carrier_name || "") as string,
    status: (l.status || "") as string,
    revenue: Number(l.revenue) || 0,
    carrierCost: Number(l.carrier_cost) || 0,
    margin: Number(l.margin) || 0,
    marginPercent: Number(l.margin_percent) || 0,
    pickupDate: (l.pickup_date || "") as string,
    assignedRep: (l.assigned_rep || "") as string,
  })), [rawLoads])

  const invoices = useMemo(() => rawInvoices.map((i: Record<string, unknown>) => ({
    id: i.id as string,
    loadId: (i.load_id || "") as string,
    shipper: (i.shipper_name || "") as string,
    amount: Number(i.amount) || 0,
    status: (i.status || "Pending") as string,
    issueDate: (i.issue_date || "") as string,
    dueDate: (i.due_date || "") as string,
    daysOutstanding: Number(i.days_outstanding) || 0,
  })), [rawInvoices])

  const shippers = useMemo(() => rawShippers.map((s: Record<string, unknown>) => ({
    company: (s.company || "") as string,
    industry: (s.industry || "") as string,
    pipelineStage: (s.pipeline_stage || "") as string,
    contractStatus: (s.contract_status || "") as string,
    annualRevenue: Number(s.annual_revenue) || 0,
    assignedRep: (s.assigned_rep || "") as string,
    conversionProbability: Number(s.conversion_probability) || 0,
  })), [rawShippers])

  const carriers = useMemo(() => rawCarriers.map((c: Record<string, unknown>) => ({
    company: (c.company || "") as string,
    mcNumber: (c.mc_number || "") as string,
    insuranceStatus: (c.insurance_status || "") as string,
    performanceScore: Number(c.performance_score) || 0,
    onTimePercent: Number(c.on_time_percent) || 0,
    lanesCovered: (() => { try { return Array.isArray(c.lanes_covered) ? c.lanes_covered : JSON.parse(c.lanes_covered as string || "[]") } catch { return [] } })() as string[],
    riskFlag: c.risk_flag as boolean || false,
  })), [rawCarriers])

  const [reports, setReports] = useState<CustomReport[]>(prebuiltReports)
  const [createOpen, setCreateOpen] = useState(false)
  const [previewReport, setPreviewReport] = useState<CustomReport | null>(null)
  const [form, setForm] = useState({ name: "", dataSource: "", columns: [] as string[], dateRange: "30d" })

  const availableColumns = dataSources.find((ds) => ds.value === form.dataSource)?.columns || []

  const toggleColumn = (col: string) => {
    setForm((p) => ({
      ...p,
      columns: p.columns.includes(col) ? p.columns.filter((c) => c !== col) : [...p.columns, col],
    }))
  }

  const handleCreate = useCallback(() => {
    const newId = `R-${String(reports.length + 1).padStart(3, "0")}`
    const report: CustomReport = {
      id: newId,
      name: form.name,
      dataSource: form.dataSource,
      columns: form.columns,
      dateRange: form.dateRange,
      createdAt: new Date().toISOString().slice(0, 10),
    }
    setReports((prev) => [report, ...prev])
    toast.success(`Report "${form.name}" created`)
    setCreateOpen(false)
    setForm({ name: "", dataSource: "", columns: [], dateRange: "30d" })
  }, [form, reports])

  const deleteReport = useCallback((id: string) => {
    setReports((prev) => prev.filter((r) => r.id !== id))
    toast.success("Report deleted")
  }, [])

  const getReportRows = useCallback((report: CustomReport): (string | number)[][] => {
    if (report.dataSource === "loads") {
      return loads.map((l: any) => report.columns.map((col) => {
        const map: Record<string, string | number> = { "Load ID": l.id, "Origin": l.origin, "Destination": l.destination, "Shipper": l.shipper, "Carrier": l.carrier, "Status": l.status, "Revenue": l.revenue, "Carrier Cost": l.carrierCost, "Margin": l.margin, "Margin %": l.marginPercent, "Pickup Date": l.pickupDate, "Rep": l.assignedRep }
        return map[col] ?? ""
      }))
    } else if (report.dataSource === "invoices") {
      return invoices.map((i: any) => report.columns.map((col) => {
        const map: Record<string, string | number> = { "Invoice ID": i.id, "Load ID": i.loadId, "Shipper": i.shipper, "Amount": i.amount, "Status": i.status, "Issue Date": i.issueDate, "Due Date": i.dueDate, "Days Outstanding": i.daysOutstanding }
        return map[col] ?? ""
      }))
    } else if (report.dataSource === "shippers") {
      return shippers.map((s: any) => report.columns.map((col) => {
        const map: Record<string, string | number> = { "Company": s.company, "Industry": s.industry, "Pipeline Stage": s.pipelineStage, "Contract Status": s.contractStatus, "Annual Revenue": s.annualRevenue, "Rep": s.assignedRep, "AI Score": s.conversionProbability }
        return map[col] ?? ""
      }))
    } else if (report.dataSource === "carriers") {
      return carriers.map((c: any) => report.columns.map((col) => {
        const map: Record<string, string | number> = { "Company": c.company, "MC Number": c.mcNumber, "Insurance": c.insuranceStatus, "Performance": c.performanceScore, "On-time %": c.onTimePercent, "Lanes": c.lanesCovered.join("; "), "Risk Flag": c.riskFlag ? "Yes" : "No" }
        return map[col] ?? ""
      }))
    }
    return []
  }, [loads, invoices, shippers, carriers])

  const exportReport = useCallback((report: CustomReport) => {
    const rows = getReportRows(report)
    const csv = generateCSV(report.columns, rows)
    downloadCSV(csv, `${report.name.replace(/\s+/g, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`)
    toast.success(`Exported "${report.name}" to CSV`)
  }, [getReportRows])

  const previewData = useMemo(() => {
    if (!previewReport) return []
    const rows = getReportRows(previewReport)
    return rows.map((row) => {
      const obj: Record<string, string | number> = {}
      previewReport.columns.forEach((col, i) => { obj[col] = row[i] })
      return obj
    })
  }, [previewReport, getReportRows])

  const chartData = useMemo(() => {
    if (!previewReport) return null
    if (previewReport.dataSource === "loads" && previewReport.columns.includes("Revenue")) {
      return loads.map((l: any) => ({ name: l.id, Revenue: l.revenue, Cost: l.carrierCost, Margin: l.margin }))
    }
    if (previewReport.dataSource === "carriers" && previewReport.columns.includes("Performance")) {
      return carriers.map((c: any) => ({ name: c.company.split(" ")[0], Performance: c.performanceScore, "On-time": c.onTimePercent }))
    }
    return null
  }, [previewReport, loads, carriers])

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        {/* Header skeleton */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded" />
              <Skeleton className="h-6 w-[160px]" />
            </div>
            <Skeleton className="h-4 w-[300px] mt-1.5" />
          </div>
          <Skeleton className="h-8 w-[100px]" />
        </div>

        {/* Report cards grid skeleton */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="border-border bg-card">
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-4 w-4 rounded" />
                    <Skeleton className="h-4 w-[150px]" />
                  </div>
                  <Skeleton className="h-5 w-[50px] rounded-full" />
                </div>
                <div className="flex flex-wrap gap-1 mb-3">
                  {Array.from({ length: 3 + (i % 3) }).map((_, j) => (
                    <Skeleton key={j} className="h-5 w-[55px] rounded-full" />
                  ))}
                </div>
                <div className="flex items-center justify-between">
                  <Skeleton className="h-3 w-[140px]" />
                  <div className="flex items-center gap-1">
                    <Skeleton className="h-7 w-7 rounded-md" />
                    <Skeleton className="h-7 w-7 rounded-md" />
                    <Skeleton className="h-7 w-7 rounded-md" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2"><BarChart3 className="h-5 w-5 text-muted-foreground" /><h1 className="text-xl font-semibold tracking-tight text-foreground">Custom Reports</h1></div>
          <p className="text-sm text-muted-foreground mt-0.5">Create, preview, and export custom reports from your data</p>
        </div>
        <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => setCreateOpen(true)}><Plus className="h-3.5 w-3.5" />New Report</Button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {reports.map((report) => (
          <Card key={report.id} className="border-border bg-card hover:border-accent/30 transition-colors">
            <CardContent className="p-4">
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2"><FileText className="h-4 w-4 text-muted-foreground" /><h3 className="text-sm font-medium text-card-foreground">{report.name}</h3></div>
                <Badge variant="secondary" className="text-[9px] capitalize">{report.dataSource}</Badge>
              </div>
              <div className="flex flex-wrap gap-1 mb-3">{report.columns.map((col) => (<Badge key={col} variant="outline" className="text-[9px]">{col}</Badge>))}</div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">Range: {dateRanges.find((d) => d.value === report.dateRange)?.label} &middot; {report.createdAt}</span>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPreviewReport(report)}><Eye className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => exportReport(report)}><Download className="h-3.5 w-3.5" /></Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => deleteReport(report.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Create Report Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="text-base">Create Custom Report</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5"><Label className="text-xs">Report Name</Label><Input placeholder="e.g., Weekly Margin Analysis" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="h-9 text-sm" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Data Source</Label>
                <Select value={form.dataSource} onValueChange={(v) => setForm((p) => ({ ...p, dataSource: v, columns: [] }))}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select..." /></SelectTrigger>
                  <SelectContent>{dataSources.map((ds) => <SelectItem key={ds.value} value={ds.value}>{ds.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Date Range</Label>
                <Select value={form.dateRange} onValueChange={(v) => setForm((p) => ({ ...p, dateRange: v }))}>
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>{dateRanges.map((dr) => <SelectItem key={dr.value} value={dr.value}>{dr.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            {form.dataSource && (
              <div className="space-y-1.5">
                <Label className="text-xs">Columns ({form.columns.length} selected)</Label>
                <div className="grid grid-cols-2 gap-2 max-h-40 overflow-auto p-2 rounded-md border border-border">
                  {availableColumns.map((col) => (
                    <label key={col} className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                      <Checkbox checked={form.columns.includes(col)} onCheckedChange={() => toggleColumn(col)} />
                      {col}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button size="sm" className="text-xs" onClick={handleCreate} disabled={!form.name || !form.dataSource || form.columns.length === 0}>Create Report</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview Report Dialog */}
      <Dialog open={!!previewReport} onOpenChange={(open) => !open && setPreviewReport(null)}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          {previewReport && (
            <>
              <DialogHeader>
                <div className="flex items-center justify-between">
                  <DialogTitle className="text-base">{previewReport.name}</DialogTitle>
                  <Button variant="outline" size="sm" className="text-xs gap-1.5" onClick={() => exportReport(previewReport)}>
                    <Download className="h-3.5 w-3.5" />Export CSV
                  </Button>
                </div>
              </DialogHeader>
              {chartData && (
                <div className="mb-4">
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                      <RechartsTooltip content={<CustomBarTooltip />} />
                      {Object.keys(chartData[0] || {}).filter((k) => k !== "name").map((key, i) => (
                        <Bar key={key} dataKey={key} name={key} fill={["#3b82f6", "#64748b", "#22c55e", "#f59e0b"][i % 4]} radius={[3, 3, 0, 0]} maxBarSize={28} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      {previewReport.columns.map((col) => (<TableHead key={col} className="text-xs">{col}</TableHead>))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewData.map((row, i) => (
                      <TableRow key={i} className="hover:bg-secondary/30 transition-colors">
                        {previewReport.columns.map((col) => (
                          <TableCell key={col} className="text-xs py-2 text-muted-foreground">
                            {typeof row[col] === "number" && (row[col] as number) > 100 ? formatCurrency(row[col] as number) : String(row[col])}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
