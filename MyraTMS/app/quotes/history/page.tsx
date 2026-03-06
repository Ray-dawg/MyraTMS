"use client"

import { useState, useMemo } from "react"
import Link from "next/link"
import { Search, ArrowLeft, ArrowRight, Calculator } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useQuotes } from "@/lib/api"

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", minimumFractionDigits: 0 }).format(value)
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
    sent: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    accepted: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    declined: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    expired: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  }
  return <Badge className={styles[status] || styles.draft}>{status}</Badge>
}

function ConfidenceBadge({ label }: { label: string }) {
  if (label === "HIGH") return <Badge variant="outline" className="border-green-300 text-green-700 dark:text-green-400 text-[10px]">HIGH</Badge>
  if (label === "MEDIUM") return <Badge variant="outline" className="border-yellow-300 text-yellow-700 dark:text-yellow-400 text-[10px]">MEDIUM</Badge>
  return <Badge variant="outline" className="border-red-300 text-red-700 dark:text-red-400 text-[10px]">LOW</Badge>
}

export default function QuoteHistoryPage() {
  const [statusFilter, setStatusFilter] = useState("all")
  const [confidenceFilter, setConfidenceFilter] = useState("all")
  const [search, setSearch] = useState("")

  const { data: quotes, isLoading } = useQuotes({
    status: statusFilter,
    search: search || undefined,
    confidenceLabel: confidenceFilter !== "all" ? confidenceFilter : undefined,
  })

  // Conversion metrics
  const metrics = useMemo(() => {
    if (!quotes || !Array.isArray(quotes)) return { total: 0, sent: 0, accepted: 0, winRate: 0 }
    const total = quotes.length
    const sent = quotes.filter((q: Record<string, unknown>) => q.status === "sent").length
    const accepted = quotes.filter((q: Record<string, unknown>) => q.status === "accepted").length
    const decided = sent + accepted + quotes.filter((q: Record<string, unknown>) => q.status === "declined").length
    const winRate = decided > 0 ? (accepted / decided) * 100 : 0
    return { total, sent, accepted, winRate }
  }, [quotes])

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Calculator className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Quote History</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Track all generated quotes and conversion metrics
          </p>
        </div>
        <Button size="sm" asChild>
          <Link href="/quotes">
            <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
            New Quote
          </Link>
        </Button>
      </div>

      {/* Metrics bar */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Total Quotes", value: metrics.total },
          { label: "Sent", value: metrics.sent },
          { label: "Accepted", value: metrics.accepted },
          { label: "Win Rate", value: `${metrics.winRate.toFixed(1)}%` },
        ].map((m) => (
          <Card key={m.label} className="border-border bg-card">
            <CardContent className="pt-4 pb-3 px-4">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{m.label}</p>
              <p className="text-lg font-bold text-foreground mt-0.5">{m.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search quotes..." className="h-9 text-sm pl-8" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-9 text-sm w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="accepted">Accepted</SelectItem>
            <SelectItem value="declined">Declined</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
          </SelectContent>
        </Select>
        <Select value={confidenceFilter} onValueChange={setConfidenceFilter}>
          <SelectTrigger className="h-9 text-sm w-36">
            <SelectValue placeholder="Confidence" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Confidence</SelectItem>
            <SelectItem value="HIGH">High</SelectItem>
            <SelectItem value="MEDIUM">Medium</SelectItem>
            <SelectItem value="LOW">Low</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="border border-border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="text-xs">Reference</TableHead>
              <TableHead className="text-xs">Shipper</TableHead>
              <TableHead className="text-xs">Lane</TableHead>
              <TableHead className="text-xs text-right">Shipper Rate</TableHead>
              <TableHead className="text-xs">Status</TableHead>
              <TableHead className="text-xs">Confidence</TableHead>
              <TableHead className="text-xs">Source</TableHead>
              <TableHead className="text-xs">Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-8">Loading quotes...</TableCell>
              </TableRow>
            ) : !quotes || quotes.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-sm text-muted-foreground py-8">No quotes found</TableCell>
              </TableRow>
            ) : (
              (quotes as Record<string, unknown>[]).map((q) => (
                <TableRow key={q.id as string} className="hover:bg-muted/30">
                  <TableCell className="text-xs font-medium">{q.reference as string}</TableCell>
                  <TableCell className="text-xs">{(q.shipper_name as string) || "—"}</TableCell>
                  <TableCell className="text-xs">
                    <span className="flex items-center gap-1">
                      {q.origin_region as string}
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      {q.dest_region as string}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-right font-medium">{formatCurrency(Number(q.shipper_rate))}</TableCell>
                  <TableCell><StatusBadge status={q.status as string} /></TableCell>
                  <TableCell><ConfidenceBadge label={q.confidence_label as string} /></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{q.rate_source as string}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(q.created_at as string).toLocaleDateString()}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
