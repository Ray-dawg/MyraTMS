"use client"

import { useState, useMemo } from "react"
import { Search, Download, DollarSign, TrendingUp, Clock, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { StatusBadge } from "@/components/status-badge"
import { LoadQuickView } from "@/components/load-quick-view"
import { useInvoices, useLoads, useFinanceSummary } from "@/lib/api"
import { toast } from "sonner"
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip,
} from "recharts"

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
          <span className="font-medium text-popover-foreground font-mono">{formatCurrency(entry.value)}</span>
        </div>
      ))}
    </div>
  )
}

// carrierPayables and marginData are computed inside the component from API data

function downloadCSV(headers: string[], rows: (string | number)[][], filename: string) {
  const csv = [headers.join(","), ...rows.map((r) => r.map((v) => `"${v}"`).join(","))].join("\n")
  const blob = new Blob([csv], { type: "text/csv" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function FinancePage() {
  const [invoiceSearch, setInvoiceSearch] = useState("")
  const [invoiceStatus, setInvoiceStatus] = useState<string>("all")
  const [quickViewLoadId, setQuickViewLoadId] = useState<string | null>(null)

  const { data: rawInvoices = [] } = useInvoices()
  const { data: rawLoads = [] } = useLoads()
  const { data: finance } = useFinanceSummary()

  const invoices = rawInvoices.map((inv: Record<string, unknown>) => ({
    id: inv.id as string,
    loadId: (inv.load_id || "") as string,
    shipper: (inv.shipper_name || "") as string,
    amount: Number(inv.amount) || 0,
    status: (inv.status || "Pending") as string,
    issueDate: (inv.issue_date || "") as string,
    dueDate: (inv.due_date || "") as string,
    factoringStatus: (inv.factoring_status || "N/A") as string,
    daysOutstanding: Number(inv.days_outstanding) || 0,
  }))

  const carrierPayables = rawLoads
    .filter((l: Record<string, unknown>) => ["In Transit", "Delivered"].includes(l.status as string))
    .map((l: Record<string, unknown>) => ({ loadId: l.id as string, carrier: (l.carrier_name || "") as string, amount: Number(l.carrier_cost) || 0, status: l.status === "Delivered" ? "Due" : "Pending" }))

  const marginData = rawLoads.map((l: Record<string, unknown>) => ({ id: l.id as string, revenue: Number(l.revenue) || 0, cost: Number(l.carrier_cost) || 0, margin: Number(l.margin) || 0, marginPercent: Number(l.margin_percent) || 0 }))

  const filteredInvoices = invoices.filter((inv: { id: string; shipper: string; status: string }) => {
    const matchSearch = !invoiceSearch || inv.id.toLowerCase().includes(invoiceSearch.toLowerCase()) || inv.shipper.toLowerCase().includes(invoiceSearch.toLowerCase())
    const matchStatus = invoiceStatus === "all" || inv.status === invoiceStatus
    return matchSearch && matchStatus
  })

  // Compute aging receivables from real invoice data
  const agingReceivables = useMemo(() => {
    const now = new Date()
    const buckets = [
      { range: "0-30 days", amount: 0 },
      { range: "31-60 days", amount: 0 },
      { range: "61-90 days", amount: 0 },
      { range: "90+ days", amount: 0 },
    ]
    invoices.forEach((inv: { status: string; amount: number; dueDate: string; daysOutstanding: number }) => {
      if (inv.status === "Paid") return
      const days = inv.daysOutstanding > 0
        ? inv.daysOutstanding
        : inv.dueDate
          ? Math.max(0, Math.floor((now.getTime() - new Date(inv.dueDate).getTime()) / (1000 * 60 * 60 * 24)))
          : 0
      if (days <= 30) buckets[0].amount += inv.amount
      else if (days <= 60) buckets[1].amount += inv.amount
      else if (days <= 90) buckets[2].amount += inv.amount
      else buckets[3].amount += inv.amount
    })
    return buckets
  }, [invoices])

  const totalInvoiced = finance?.outstanding ? finance.outstanding + finance.collected : invoices.reduce((sum: number, i: { amount: number }) => sum + i.amount, 0)
  const totalPaid = finance?.collected || 0
  const totalOverdue = finance?.overdue || 0
  const totalMargin = finance?.totalMargin || 0

  const handleExport = () => {
    const headers = ["Invoice ID", "Load ID", "Shipper", "Amount", "Status", "Issue Date", "Due Date", "Factoring", "Days Outstanding"]
    const rows = filteredInvoices.map((inv: any) => [inv.id, inv.loadId, inv.shipper, inv.amount, inv.status, inv.issueDate, inv.dueDate, inv.factoringStatus, inv.daysOutstanding])
    downloadCSV(headers, rows, `finance-report-${new Date().toISOString().slice(0, 10)}.csv`)
    toast.success(`Exported ${filteredInvoices.length} invoices to CSV`)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Finance</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Invoices, payables, and margin analysis</p>
        </div>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={handleExport}>
          <Download className="h-3.5 w-3.5" />
          Export Report
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4 px-6 py-4">
        <Card className="border-border bg-card"><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><DollarSign className="h-3.5 w-3.5 text-muted-foreground" /><p className="text-[11px] text-muted-foreground">Total Invoiced</p></div><p className="text-2xl font-semibold text-card-foreground font-mono">{formatCurrency(totalInvoiced)}</p></CardContent></Card>
        <Card className="border-border bg-card"><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><TrendingUp className="h-3.5 w-3.5 text-success" /><p className="text-[11px] text-muted-foreground">Collected</p></div><p className="text-2xl font-semibold text-success font-mono">{formatCurrency(totalPaid)}</p></CardContent></Card>
        <Card className="border-border bg-card"><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><AlertTriangle className="h-3.5 w-3.5 text-destructive" /><p className="text-[11px] text-muted-foreground">Overdue</p></div><p className="text-2xl font-semibold text-destructive font-mono">{formatCurrency(totalOverdue)}</p></CardContent></Card>
        <Card className="border-border bg-card"><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><DollarSign className="h-3.5 w-3.5 text-accent" /><p className="text-[11px] text-muted-foreground">Total Margin</p></div><p className="text-2xl font-semibold text-accent font-mono">{formatCurrency(totalMargin)}</p></CardContent></Card>
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-hidden px-6">
        <Tabs defaultValue="invoices" className="flex flex-col h-full">
          <TabsList className="w-fit bg-secondary/30 h-9 mb-4">
            <TabsTrigger value="invoices" className="text-xs">Invoices</TabsTrigger>
            <TabsTrigger value="payables" className="text-xs">Carrier Payables</TabsTrigger>
            <TabsTrigger value="margins" className="text-xs">Margin Dashboard</TabsTrigger>
            <TabsTrigger value="aging" className="text-xs">Aging Receivables</TabsTrigger>
          </TabsList>

          <TabsContent value="invoices" className="flex-1 flex flex-col overflow-hidden mt-0">
            <div className="flex items-center gap-3 mb-4">
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={invoiceSearch} onChange={(e) => setInvoiceSearch(e.target.value)} placeholder="Search invoices..." className="h-8 pl-8 text-xs bg-secondary/30" />
              </div>
              <Select value={invoiceStatus} onValueChange={setInvoiceStatus}>
                <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="Pending">Pending</SelectItem>
                  <SelectItem value="Sent">Sent</SelectItem>
                  <SelectItem value="Paid">Paid</SelectItem>
                  <SelectItem value="Overdue">Overdue</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 overflow-auto scrollbar-thin">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-xs">Invoice ID</TableHead>
                    <TableHead className="text-xs">Load</TableHead>
                    <TableHead className="text-xs">Shipper</TableHead>
                    <TableHead className="text-right text-xs">Amount</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs">Issue Date</TableHead>
                    <TableHead className="text-xs">Due Date</TableHead>
                    <TableHead className="text-xs">Factoring</TableHead>
                    <TableHead className="text-right text-xs">Days Out</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredInvoices.map((inv: any) => (
                    <TableRow key={inv.id} className="hover:bg-secondary/30 transition-colors">
                      <TableCell className="text-xs font-medium text-foreground font-mono py-2.5">{inv.id}</TableCell>
                      <TableCell className="py-2.5">
                        <button
                          onClick={() => setQuickViewLoadId(inv.loadId)}
                          className="text-xs text-accent font-mono hover:underline underline-offset-2 transition-colors cursor-pointer"
                        >
                          {inv.loadId}
                        </button>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground py-2.5">{inv.shipper}</TableCell>
                      <TableCell className="text-right text-xs font-medium text-foreground font-mono py-2.5">{formatCurrency(inv.amount)}</TableCell>
                      <TableCell className="py-2.5"><StatusBadge status={inv.status} /></TableCell>
                      <TableCell className="text-xs text-muted-foreground py-2.5">{new Date(inv.issueDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</TableCell>
                      <TableCell className="text-xs text-muted-foreground py-2.5">{new Date(inv.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</TableCell>
                      <TableCell className="py-2.5"><StatusBadge status={inv.factoringStatus} /></TableCell>
                      <TableCell className="text-right text-xs font-mono py-2.5">
                        <span className={inv.daysOutstanding > 15 ? "text-destructive" : "text-muted-foreground"}>{inv.daysOutstanding}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="payables" className="flex-1 overflow-auto scrollbar-thin mt-0">
            <Table>
              <TableHeader><TableRow className="hover:bg-transparent"><TableHead className="text-xs">Load</TableHead><TableHead className="text-xs">Carrier</TableHead><TableHead className="text-right text-xs">Amount</TableHead><TableHead className="text-xs">Status</TableHead></TableRow></TableHeader>
              <TableBody>
                {carrierPayables.map((p: any) => (
                  <TableRow key={p.loadId} className="hover:bg-secondary/30 transition-colors">
                    <TableCell className="py-2.5">
                      <button
                        onClick={() => setQuickViewLoadId(p.loadId)}
                        className="text-xs font-mono text-accent hover:underline underline-offset-2 cursor-pointer"
                      >
                        {p.loadId}
                      </button>
                    </TableCell>
                    <TableCell className="text-xs text-foreground py-2.5">{p.carrier}</TableCell>
                    <TableCell className="text-right text-xs font-mono text-foreground py-2.5">{formatCurrency(p.amount)}</TableCell>
                    <TableCell className="py-2.5"><StatusBadge status={p.status === "Due" ? "Pending" : "Sent"} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>

          <TabsContent value="margins" className="flex-1 overflow-auto scrollbar-thin mt-0">
            <Card className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Margin by Load</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={marginData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="id" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
                    <RechartsTooltip content={<CustomBarTooltip />} />
                    <Bar dataKey="revenue" name="Revenue" fill="#3b82f6" radius={[3, 3, 0, 0]} maxBarSize={28} />
                    <Bar dataKey="cost" name="Cost" fill="#64748b" radius={[3, 3, 0, 0]} maxBarSize={28} />
                    <Bar dataKey="margin" name="Margin" fill="#22c55e" radius={[3, 3, 0, 0]} maxBarSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="aging" className="flex-1 overflow-auto scrollbar-thin mt-0">
            <Card className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Aging Receivables</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={agingReceivables}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="range" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v / 1000}k`} />
                    <RechartsTooltip content={<CustomBarTooltip />} />
                    <Bar dataKey="amount" name="Outstanding" fill="#f59e0b" radius={[3, 3, 0, 0]} maxBarSize={48} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Load Quick View Dialog */}
      <LoadQuickView
        loadId={quickViewLoadId}
        open={!!quickViewLoadId}
        onClose={() => setQuickViewLoadId(null)}
      />
    </div>
  )
}
