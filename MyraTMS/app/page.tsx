"use client"

import { useMemo } from "react"
import {
  Truck,
  DollarSign,
  FileText,
  AlertTriangle,
  TrendingUp,
  ArrowUpRight,
  ArrowDownRight,
  Sparkles,
  Loader2,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useFinanceSummary, useLoads, useInvoices, useNotifications } from "@/lib/api"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  PieChart,
  Pie,
  Cell,
} from "recharts"

const STATUS_COLORS: Record<string, string> = {
  "Booked": "#6366f1",
  "Dispatched": "#3b82f6",
  "In Transit": "#22c55e",
  "Delivered": "#14b8a6",
  "Invoiced": "#f59e0b",
  "Closed": "#64748b",
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
  }).format(value)
}

function formatCompact(value: number) {
  if (value >= 1000) return `$${(value / 1000).toFixed(0)}k`
  return `$${value}`
}

function CustomPieTooltip({ active, payload }: { active?: boolean; payload?: Array<{ name: string; value: number; payload: { status: string } }> }) {
  if (!active || !payload || !payload.length) return null
  const item = payload[0]
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 shadow-md">
      <p className="text-xs font-medium text-popover-foreground">{item.payload.status}</p>
      <p className="text-sm font-semibold text-popover-foreground">{item.value} loads</p>
    </div>
  )
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

export default function DashboardPage() {
  const { data: finance, isLoading: financeLoading } = useFinanceSummary()
  const { data: rawLoads, isLoading: loadsLoading } = useLoads()
  const { data: rawInvoices, isLoading: invoicesLoading } = useInvoices()
  const { data: rawNotifications } = useNotifications()

  const isLoading = financeLoading || loadsLoading

  const loads = rawLoads || []
  const invoices = rawInvoices || []

  const activeLoads = loads.filter((l: { status: string }) => ["Booked", "Dispatched", "In Transit"].includes(l.status)).length
  const atRiskLoads = loads.filter((l: { risk_flag: boolean }) => l.risk_flag).length
  const inTransitCount = finance?.inTransit || loads.filter((l: { status: string }) => l.status === "In Transit").length

  // Compute load status distribution from real data
  const loadStatusDistribution = useMemo(() => {
    const statusMap: Record<string, number> = {}
    loads.forEach((l: { status: string }) => {
      const status = l.status || "Unknown"
      statusMap[status] = (statusMap[status] || 0) + 1
    })
    return Object.entries(statusMap).map(([status, count]) => ({ status, count }))
  }, [loads])

  // Compute aging receivables from real invoice data
  const agingReceivables = useMemo(() => {
    const now = new Date()
    const buckets = [
      { range: "0-30 days", amount: 0 },
      { range: "31-60 days", amount: 0 },
      { range: "61-90 days", amount: 0 },
      { range: "90+ days", amount: 0 },
    ]
    invoices.forEach((inv: Record<string, unknown>) => {
      const status = inv.status as string
      if (status === "Paid") return
      const amount = Number(inv.amount) || 0
      const daysOut = Number(inv.days_outstanding) || 0
      const dueDate = inv.due_date as string
      const days = daysOut > 0
        ? daysOut
        : dueDate
          ? Math.max(0, Math.floor((now.getTime() - new Date(dueDate).getTime()) / (1000 * 60 * 60 * 24)))
          : 0
      if (days <= 30) buckets[0].amount += amount
      else if (days <= 60) buckets[1].amount += amount
      else if (days <= 90) buckets[2].amount += amount
      else buckets[3].amount += amount
    })
    return buckets
  }, [invoices])

  // Compute revenue vs cost data by month from real loads
  const revenueVsCostData = useMemo(() => {
    const monthMap: Record<string, { revenue: number; cost: number }> = {}
    loads.forEach((l: Record<string, unknown>) => {
      const date = (l.pickup_date || l.created_at || "") as string
      if (!date) return
      const d = new Date(date)
      const month = d.toLocaleDateString("en-US", { month: "short" })
      if (!monthMap[month]) monthMap[month] = { revenue: 0, cost: 0 }
      monthMap[month].revenue += Number(l.revenue) || 0
      monthMap[month].cost += Number(l.carrier_cost) || 0
    })
    return Object.entries(monthMap).map(([month, data]) => ({ month, revenue: data.revenue, cost: data.cost }))
  }, [loads])

  // Recent activity from notifications
  const recentActivity = useMemo(() => {
    if (!Array.isArray(rawNotifications)) return []
    return rawNotifications.slice(0, 5).map((n: Record<string, unknown>) => ({
      id: String(n.id || ""),
      title: String(n.title || ""),
      description: String(n.description || n.message || ""),
      type: String(n.type || "info"),
      timestamp: String(n.created_at || n.timestamp || ""),
      user: String(n.created_by || "System"),
    }))
  }, [rawNotifications])

  // Compute average margin
  const avgMarginPercent = useMemo(() => {
    if (loads.length === 0) return 0
    const total = loads.reduce((sum: number, l: Record<string, unknown>) => sum + (Number(l.margin_percent) || 0), 0)
    return Math.round(total / loads.length)
  }, [loads])

  const metricCards = [
    { title: "Active Loads", value: activeLoads, format: "number" as const, icon: Truck, trend: `${inTransitCount} in transit`, trendUp: true },
    { title: "Total Revenue", value: finance?.totalRevenue || 0, format: "currency" as const, icon: TrendingUp, trend: `Avg ${avgMarginPercent}% margin`, trendUp: true },
    { title: "Total Margin", value: finance?.totalMargin || 0, format: "currency" as const, icon: DollarSign, trend: `${loads.length} loads`, trendUp: true },
    { title: "Outstanding", value: finance?.outstanding || 0, format: "currency" as const, icon: FileText, trend: `${finance?.overdue ? formatCurrency(finance.overdue) + " overdue" : "No overdue"}`, trendUp: false },
    { title: "At-Risk Loads", value: atRiskLoads, format: "number" as const, icon: AlertTriangle, trend: "AI flagged", trendUp: false },
  ]

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })

  return (
    <div className="p-6 space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Operations Overview
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {today}
        </p>
      </div>

      {/* Metrics Row */}
      {isLoading ? (
        <div className="grid grid-cols-5 gap-4">
          {[...Array(5)].map((_, i) => (
            <Card key={i} className="border-border bg-card">
              <CardContent className="p-4 flex items-center justify-center h-[100px]">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-5 gap-4">
          {metricCards.map((metric) => (
            <Card
              key={metric.title}
              className="border-border bg-card"
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-muted-foreground">
                    {metric.title}
                  </span>
                  <metric.icon className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="text-2xl font-semibold text-card-foreground tracking-tight">
                  {metric.format === "currency"
                    ? formatCurrency(metric.value)
                    : metric.value}
                </div>
                <div className="flex items-center gap-1 mt-1.5">
                  {metric.trendUp ? (
                    <ArrowUpRight className="h-3 w-3 text-success" />
                  ) : (
                    <ArrowDownRight className="h-3 w-3 text-destructive" />
                  )}
                  <span
                    className={`text-[11px] ${
                      metric.trendUp
                        ? "text-success"
                        : "text-destructive"
                    }`}
                  >
                    {metric.trend}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-3 gap-4">
        {/* Revenue vs Carrier Cost */}
        <Card className="col-span-2 border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-card-foreground">
              Revenue vs Carrier Cost
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-4">
            {revenueVsCostData.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={revenueVsCostData} barGap={2}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--border)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => formatCompact(v)}
                  />
                  <RechartsTooltip content={<CustomBarTooltip />} />
                  <Bar
                    dataKey="revenue"
                    name="Revenue"
                    fill="#3b82f6"
                    radius={[3, 3, 0, 0]}
                    maxBarSize={32}
                  />
                  <Bar
                    dataKey="cost"
                    name="Carrier Cost"
                    fill="#64748b"
                    radius={[3, 3, 0, 0]}
                    maxBarSize={32}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[240px] text-sm text-muted-foreground">
                {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : "No load data available"}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Load Status Distribution */}
        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-card-foreground">
              Load Status Distribution
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadStatusDistribution.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={170}>
                  <PieChart>
                    <Pie
                      data={loadStatusDistribution}
                      dataKey="count"
                      nameKey="status"
                      cx="50%"
                      cy="50%"
                      innerRadius={42}
                      outerRadius={68}
                      paddingAngle={3}
                      strokeWidth={0}
                    >
                      {loadStatusDistribution.map((entry) => (
                        <Cell key={entry.status} fill={STATUS_COLORS[entry.status] || "#64748b"} />
                      ))}
                    </Pie>
                    <RechartsTooltip content={<CustomPieTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 mt-3">
                  {loadStatusDistribution.map((item) => (
                    <div key={item.status} className="flex items-center gap-2 text-[11px]">
                      <span
                        className="h-2.5 w-2.5 rounded-sm shrink-0"
                        style={{ backgroundColor: STATUS_COLORS[item.status] || "#64748b" }}
                      />
                      <span className="text-muted-foreground truncate">{item.status}</span>
                      <span className="ml-auto text-card-foreground font-semibold font-mono">
                        {item.count}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-[200px] text-sm text-muted-foreground">No data</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Bottom Row */}
      <div className="grid grid-cols-3 gap-4">
        {/* Aging Receivables */}
        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-card-foreground">
              Aging Receivables
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={agingReceivables} layout="vertical">
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border)"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => formatCompact(v)}
                />
                <YAxis
                  dataKey="range"
                  type="category"
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                  width={70}
                />
                <RechartsTooltip content={<CustomBarTooltip />} />
                <Bar
                  dataKey="amount"
                  name="Outstanding"
                  fill="#f59e0b"
                  radius={[0, 3, 3, 0]}
                  maxBarSize={20}
                />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* AI Insight Card */}
        <Card className="border-border bg-card border-l-2 border-l-accent">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-accent" />
              <CardTitle className="text-sm font-medium text-card-foreground">
                AI Insights
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {atRiskLoads > 0 ? (
              <div className="rounded-md bg-accent/5 p-3 text-xs leading-relaxed text-card-foreground">
                <p className="font-medium mb-1">{atRiskLoads} load{atRiskLoads > 1 ? "s" : ""} flagged at risk.</p>
                <p className="text-muted-foreground">
                  Review at-risk loads for carrier compliance issues and declining on-time performance. Recommend proactive shipper communication.
                </p>
              </div>
            ) : (
              <div className="rounded-md bg-accent/5 p-3 text-xs leading-relaxed text-card-foreground">
                <p className="font-medium mb-1">Operations running smoothly.</p>
                <p className="text-muted-foreground">
                  No loads flagged at risk. Average margin at {avgMarginPercent}% across {loads.length} loads.
                </p>
              </div>
            )}
            <div className="rounded-md bg-accent/5 p-3 text-xs leading-relaxed text-card-foreground">
              <p className="font-medium mb-1">Financial summary.</p>
              <p className="text-muted-foreground">
                {formatCurrency(finance?.totalRevenue || 0)} total revenue with {formatCurrency(finance?.totalMargin || 0)} margin.
                {(finance?.overdue || 0) > 0
                  ? ` ${formatCurrency(finance?.overdue || 0)} overdue -- follow up on aging receivables.`
                  : " No overdue invoices."}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-card-foreground">
              Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentActivity.length > 0 ? recentActivity.map((activity) => (
                <div key={activity.id} className="flex gap-3">
                  <div className="mt-0.5">
                    <span
                      className={`block h-1.5 w-1.5 rounded-full ${
                        activity.type === "warning" || activity.type === "error"
                          ? "bg-destructive"
                          : activity.type === "success"
                          ? "bg-success"
                          : "bg-muted-foreground"
                      }`}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-card-foreground truncate">
                      {activity.title}
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {activity.description}
                    </p>
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                      {activity.user} &middot;{" "}
                      {activity.timestamp ? new Date(activity.timestamp).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      }) : ""}
                    </p>
                  </div>
                </div>
              )) : (
                <p className="text-xs text-muted-foreground">No recent activity</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
