"use client"

import Link from "next/link"
import { ArrowLeft, BarChart3, TrendingUp, Target, DollarSign, ArrowRight } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line,
} from "recharts"
import { useQuoteAnalytics } from "@/lib/api"

const COLORS = ["hsl(var(--chart-1))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--chart-4))", "hsl(var(--chart-5))"]

function formatCurrency(v: number) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", minimumFractionDigits: 0 }).format(v)
}

export default function QuoteAnalyticsPage() {
  const { data, isLoading } = useQuoteAnalytics()

  if (isLoading || !data) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">Loading analytics...</p>
      </div>
    )
  }

  const analytics = data as {
    accuracyBySource: { rate_source: string; avg_accuracy: number; count: number }[]
    conversionMetrics: { status: string; count: number }[]
    mostQuotedLanes: { origin_region: string; dest_region: string; quote_count: number; avg_rate: number }[]
    sourceUtilization: { rate_source: string; count: number }[]
    marginRealization: { avg_quoted_margin: number; avg_actual_margin: number }
    recentQuotes: { date: string; count: number }[]
  }

  const totalQuotes = analytics.conversionMetrics.reduce((s, m) => s + Number(m.count), 0)
  const accepted = Number(analytics.conversionMetrics.find((m) => m.status === "accepted")?.count || 0)
  const decided = accepted
    + Number(analytics.conversionMetrics.find((m) => m.status === "declined")?.count || 0)
    + Number(analytics.conversionMetrics.find((m) => m.status === "sent")?.count || 0)
  const winRate = decided > 0 ? (accepted / decided) * 100 : 0

  const avgAccuracy = analytics.accuracyBySource.length > 0
    ? analytics.accuracyBySource.reduce((s, a) => s + Number(a.avg_accuracy) * Number(a.count), 0) /
      analytics.accuracyBySource.reduce((s, a) => s + Number(a.count), 0)
    : 0

  const avgMargin = Number(analytics.marginRealization.avg_quoted_margin || 0)

  // Chart data
  const accuracyChartData = analytics.accuracyBySource.map((a) => ({
    source: a.rate_source,
    accuracy: (Number(a.avg_accuracy) * 100).toFixed(1),
    count: Number(a.count),
  }))

  const sourceChartData = analytics.sourceUtilization.map((s) => ({
    name: s.rate_source,
    value: Number(s.count),
  }))

  const volumeChartData = analytics.recentQuotes.map((r) => ({
    date: new Date(r.date).toLocaleDateString("en-CA", { month: "short", day: "numeric" }),
    quotes: Number(r.count),
  }))

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Button variant="ghost" size="sm" className="mb-2 -ml-2 text-xs text-muted-foreground" asChild>
            <Link href="/quotes"><ArrowLeft className="h-3 w-3 mr-1" /> Quotes</Link>
          </Button>
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Quote Analytics</h1>
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Avg Accuracy", value: avgAccuracy > 0 ? `${(avgAccuracy * 100).toFixed(1)}%` : "—", icon: Target, color: "text-blue-600" },
          { label: "Win Rate", value: `${winRate.toFixed(1)}%`, icon: TrendingUp, color: "text-green-600" },
          { label: "Total Quotes", value: totalQuotes, icon: BarChart3, color: "text-foreground" },
          { label: "Avg Margin", value: avgMargin > 0 ? `${(avgMargin * 100).toFixed(1)}%` : "—", icon: DollarSign, color: "text-emerald-600" },
        ].map((kpi) => (
          <Card key={kpi.label} className="border-border bg-card">
            <CardContent className="pt-4 pb-3 px-4">
              <div className="flex items-center gap-2 mb-1">
                <kpi.icon className="h-3.5 w-3.5 text-muted-foreground" />
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{kpi.label}</p>
              </div>
              <p className={`text-xl font-bold ${kpi.color}`}>{kpi.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Accuracy by Source */}
        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Accuracy by Source</CardTitle>
          </CardHeader>
          <CardContent>
            {accuracyChartData.length === 0 ? (
              <p className="text-xs text-muted-foreground py-8 text-center">No accuracy data yet — deliver quoted loads to populate</p>
            ) : (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={accuracyChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="source" className="text-xs" tick={{ fontSize: 10 }} />
                  <YAxis className="text-xs" tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Bar dataKey="accuracy" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} name="Accuracy %" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Source Utilization */}
        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Source Utilization</CardTitle>
          </CardHeader>
          <CardContent>
            {sourceChartData.length === 0 ? (
              <p className="text-xs text-muted-foreground py-8 text-center">No quotes generated yet</p>
            ) : (
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie data={sourceChartData} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}>
                    {sourceChartData.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Quote Volume */}
        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Quote Volume (30 days)</CardTitle>
          </CardHeader>
          <CardContent>
            {volumeChartData.length === 0 ? (
              <p className="text-xs text-muted-foreground py-8 text-center">No quotes in the last 30 days</p>
            ) : (
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={volumeChartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="date" className="text-xs" tick={{ fontSize: 10 }} />
                  <YAxis className="text-xs" tick={{ fontSize: 10 }} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="quotes" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Most Quoted Lanes */}
        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Most Quoted Lanes</CardTitle>
          </CardHeader>
          <CardContent>
            {analytics.mostQuotedLanes.length === 0 ? (
              <p className="text-xs text-muted-foreground py-8 text-center">No lane data yet</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="text-xs">Lane</TableHead>
                    <TableHead className="text-xs text-right">Quotes</TableHead>
                    <TableHead className="text-xs text-right">Avg Rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {analytics.mostQuotedLanes.map((lane, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs">
                        <span className="flex items-center gap-1">
                          {lane.origin_region}
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          {lane.dest_region}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-right">{lane.quote_count}</TableCell>
                      <TableCell className="text-xs text-right font-medium">{formatCurrency(Number(lane.avg_rate))}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
