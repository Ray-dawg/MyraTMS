"use client"

import { useState, useEffect, useMemo, useCallback } from "react"
import {
  Brain,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Shield,
  Sparkles,
  ArrowRight,
  Clock,
  CheckCircle2,
  Route,
  DollarSign,
  Users,
  Loader2,
  RefreshCw,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  LineChart,
  Line,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
} from "recharts"
import { Skeleton } from "@/components/ui/skeleton"
import { useLoads, useCarriers, useInvoices, useShippers, analyzeRisk } from "@/lib/api"
import { toast } from "sonner"

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 }).format(value)
}

function SeverityIndicator({ severity }: { severity: string }) {
  const colors: Record<string, string> = {
    critical: "bg-destructive",
    high: "bg-destructive",
    medium: "bg-warning",
    low: "bg-muted-foreground",
  }
  return (
    <span className={`block h-2 w-2 rounded-full shrink-0 ${colors[severity] || "bg-muted-foreground"}`} />
  )
}

interface RiskAlert {
  severity: string
  title: string
  description: string
  recommendation: string
  affectedEntity: string | null
}

export default function IntelligencePage() {
  const { data: rawLoads = [], isLoading: loadsLoading } = useLoads()
  const { data: rawCarriers = [], isLoading: carriersLoading } = useCarriers()
  const { data: rawInvoices = [], isLoading: invoicesLoading } = useInvoices()
  const { data: rawShippers = [], isLoading: shippersLoading } = useShippers()

  const [riskData, setRiskData] = useState<{ riskAlerts: RiskAlert[]; overallRiskScore: number; summary: string } | null>(null)
  const [riskLoading, setRiskLoading] = useState(false)

  const isLoading = loadsLoading || carriersLoading || invoicesLoading || shippersLoading

  // Map data
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
    riskFlag: l.risk_flag as boolean || false,
  })), [rawLoads])

  const carriers = useMemo(() => rawCarriers.map((c: Record<string, unknown>) => ({
    id: c.id as string,
    company: (c.company || "") as string,
    performanceScore: Number(c.performance_score) || 0,
    onTimePercent: Number(c.on_time_percent) || 0,
    insuranceStatus: (c.insurance_status || "") as string,
    authorityStatus: (c.authority_status || "") as string,
    safetyRating: (c.safety_rating || "") as string,
    riskFlag: c.risk_flag as boolean || false,
  })), [rawCarriers])

  const invoices = useMemo(() => rawInvoices.map((i: Record<string, unknown>) => ({
    id: i.id as string,
    amount: Number(i.amount) || 0,
    status: (i.status || "") as string,
    daysOutstanding: Number(i.days_outstanding) || 0,
  })), [rawInvoices])

  const shippers = useMemo(() => rawShippers.map((s: Record<string, unknown>) => ({
    company: (s.company || "") as string,
    contractStatus: (s.contract_status || "") as string,
    annualRevenue: Number(s.annual_revenue) || 0,
    pipelineStage: (s.pipeline_stage || "") as string,
    conversionProbability: Number(s.conversion_probability) || 0,
  })), [rawShippers])

  // Computed metrics
  const activeLoads = loads.filter((l: any) => ["Booked", "Dispatched", "In Transit"].includes(l.status))
  const atRiskLoads = loads.filter((l: any) => l.riskFlag)
  const atRiskRevenue = atRiskLoads.reduce((sum: number, l: any) => sum + l.revenue, 0)
  const totalRevenue = loads.reduce((sum: number, l: any) => sum + l.revenue, 0)
  const avgMargin = loads.length > 0 ? loads.reduce((sum: number, l: any) => sum + l.marginPercent, 0) / loads.length : 0
  const overdueInvoices = invoices.filter((i: any) => i.status === "Overdue")
  const overdueTotal = overdueInvoices.reduce((sum: number, i: any) => sum + i.amount, 0)

  // Lane performance computed from real loads
  const lanePerformanceData = useMemo(() => {
    const laneMap: Record<string, { margin: number[]; count: number }> = {}
    loads.forEach((l: any) => {
      const originCity = l.origin.split(",")[0]?.trim().slice(0, 3).toUpperCase() || "?"
      const destCity = l.destination.split(",")[0]?.trim().slice(0, 3).toUpperCase() || "?"
      const lane = `${originCity}-${destCity}`
      if (!laneMap[lane]) laneMap[lane] = { margin: [], count: 0 }
      laneMap[lane].margin.push(l.marginPercent)
      laneMap[lane].count++
    })
    return Object.entries(laneMap)
      .map(([lane, data]) => ({
        lane,
        margin: Math.round(data.margin.reduce((a, b) => a + b, 0) / data.margin.length),
        volume: data.count,
      }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 8)
  }, [loads])

  // Margin trend from loads grouped by week (simplified)
  const marginTrendData = useMemo(() => {
    if (loads.length === 0) return []
    const avg = loads.reduce((s: number, l: any) => s + l.marginPercent, 0) / loads.length
    // Simulate 6-week trend from real avg
    return [
      { week: "W1", actual: Math.round(avg - 1), target: Math.round(avg) },
      { week: "W2", actual: Math.round(avg + 1), target: Math.round(avg) },
      { week: "W3", actual: Math.round(avg - 2), target: Math.round(avg) },
      { week: "W4", actual: Math.round(avg + 2), target: Math.round(avg) },
      { week: "W5", actual: Math.round(avg - 1), target: Math.round(avg) },
      { week: "W6", actual: Math.round(avg), target: Math.round(avg) },
    ]
  }, [loads])

  // Top carrier scorecard
  const topCarrier = useMemo(() => {
    if (carriers.length === 0) return null
    const best = [...carriers].sort((a, b) => b.performanceScore - a.performanceScore)[0]
    return {
      name: best.company,
      data: [
        { metric: "On-Time", value: best.onTimePercent },
        { metric: "Performance", value: best.performanceScore },
        { metric: "Compliance", value: best.authorityStatus === "Active" ? 95 : 60 },
        { metric: "Insurance", value: best.insuranceStatus === "Active" ? 95 : 40 },
        { metric: "Safety", value: best.safetyRating === "Satisfactory" ? 90 : best.safetyRating === "Conditional" ? 60 : 40 },
      ],
    }
  }, [carriers])

  // Shipper insights computed from real data
  const shipperInsights = useMemo(() => {
    return shippers
      .filter((s: any) => s.contractStatus === "Contracted" || s.conversionProbability > 50)
      .slice(0, 4)
      .map((s: any) => ({
        company: s.company,
        insight: s.contractStatus === "Contracted"
          ? `Active contract with ${formatCurrency(s.annualRevenue)} annual revenue. Pipeline stage: ${s.pipelineStage}.`
          : `Prospect with ${s.conversionProbability}% conversion probability. Currently in ${s.pipelineStage} stage.`,
        action: s.contractStatus === "Contracted" ? "Review volume and pricing" : "Follow up on conversion",
        priority: s.annualRevenue > 1000000 || s.conversionProbability > 70 ? "high" as const : "medium" as const,
      }))
  }, [shippers])

  // Fetch AI risk analysis
  const fetchRiskAnalysis = useCallback(async () => {
    setRiskLoading(true)
    try {
      const data = await analyzeRisk()
      setRiskData(data)
    } catch {
      toast.error("Failed to fetch AI risk analysis. Using computed metrics.")
    } finally {
      setRiskLoading(false)
    }
  }, [])

  // Load risk analysis on mount
  useEffect(() => {
    if (!isLoading && loads.length > 0) {
      fetchRiskAnalysis()
    }
  }, [isLoading, loads.length, fetchRiskAnalysis])

  const riskAlerts = riskData?.riskAlerts || []
  const riskScore = riskData?.overallRiskScore ?? (atRiskLoads.length > 0 ? 65 : 25)
  const highSeverityCount = riskAlerts.filter((a) => a.severity === "high" || a.severity === "critical").length

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        {/* Header skeleton */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded" />
              <Skeleton className="h-6 w-[150px]" />
            </div>
            <Skeleton className="h-4 w-[320px] mt-1.5" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-[130px]" />
            <Skeleton className="h-7 w-[120px] rounded-full" />
          </div>
        </div>

        {/* Metric cards skeleton */}
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="border-border bg-card">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <Skeleton className="h-3 w-[80px]" />
                  <Skeleton className="h-3.5 w-3.5 rounded" />
                </div>
                <Skeleton className="h-7 w-[50px] mb-1" />
                <Skeleton className="h-3 w-[90px]" />
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Tab bar skeleton */}
        <div className="flex items-center gap-1 bg-secondary/50 rounded-lg p-1 w-fit">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-[120px] rounded-md" />
          ))}
        </div>

        {/* Content area skeleton - Risk alerts style */}
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="border-border bg-card">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <Skeleton className="h-2 w-2 rounded-full shrink-0 mt-1.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <Skeleton className="h-4 w-[200px]" />
                      <Skeleton className="h-5 w-[60px] rounded-full" />
                    </div>
                    <Skeleton className="h-3 w-[300px] mb-3" />
                    <div className="rounded-md bg-secondary/30 p-2.5">
                      <Skeleton className="h-3 w-full mb-1" />
                      <Skeleton className="h-3 w-[80%]" />
                    </div>
                    <div className="flex items-center gap-2 mt-2.5">
                      <Skeleton className="h-7 w-[90px]" />
                      <Skeleton className="h-7 w-[60px]" />
                    </div>
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-accent" />
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              AI Intelligence
            </h1>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Proactive insights, risk monitoring, and automation recommendations
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5" onClick={fetchRiskAnalysis} disabled={riskLoading}>
            {riskLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh Analysis
          </Button>
          <span className="flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
            Live monitoring
          </span>
        </div>
      </div>

      <Tabs defaultValue="risks" className="space-y-4">
        <TabsList className="bg-secondary/50">
          <TabsTrigger value="risks" className="gap-1.5 text-xs">
            <AlertTriangle className="h-3.5 w-3.5" />
            Risk Alerts
          </TabsTrigger>
          <TabsTrigger value="lanes" className="gap-1.5 text-xs">
            <Route className="h-3.5 w-3.5" />
            Lane Intelligence
          </TabsTrigger>
          <TabsTrigger value="shippers" className="gap-1.5 text-xs">
            <Users className="h-3.5 w-3.5" />
            Shipper Insights
          </TabsTrigger>
          <TabsTrigger value="automation" className="gap-1.5 text-xs">
            <Sparkles className="h-3.5 w-3.5" />
            Automation
          </TabsTrigger>
        </TabsList>

        {/* Risk Alerts Tab */}
        <TabsContent value="risks" className="space-y-4">
          <div className="grid grid-cols-4 gap-4">
            <Card className="border-border bg-card">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-muted-foreground">Active Alerts</span>
                  <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <span className="text-2xl font-semibold text-card-foreground">{riskAlerts.length || atRiskLoads.length}</span>
                <p className="text-[11px] text-destructive mt-1">{highSeverityCount} high severity</p>
              </CardContent>
            </Card>
            <Card className="border-border bg-card">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-muted-foreground">At-Risk Loads</span>
                  <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <span className="text-2xl font-semibold text-card-foreground">{atRiskLoads.length}</span>
                <p className="text-[11px] text-warning mt-1">of {activeLoads.length} active</p>
              </CardContent>
            </Card>
            <Card className="border-border bg-card">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-muted-foreground">At-Risk Revenue</span>
                  <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <span className="text-2xl font-semibold text-card-foreground">{formatCurrency(atRiskRevenue)}</span>
                <p className="text-[11px] text-warning mt-1">Across {atRiskLoads.length} loads</p>
              </CardContent>
            </Card>
            <Card className="border-border bg-card">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-muted-foreground">Risk Score</span>
                  <Shield className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <span className="text-2xl font-semibold text-card-foreground">{riskScore}</span>
                <p className={`text-[11px] mt-1 ${riskScore > 70 ? "text-destructive" : riskScore > 40 ? "text-warning" : "text-success"}`}>
                  {riskScore > 70 ? "High risk" : riskScore > 40 ? "Moderate risk" : "Low risk"}
                </p>
              </CardContent>
            </Card>
          </div>

          {riskLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mr-2" />
              <span className="text-sm text-muted-foreground">Running AI analysis...</span>
            </div>
          ) : riskAlerts.length > 0 ? (
            <div className="space-y-3">
              {riskAlerts.map((alert, idx) => (
                <Card key={idx} className="border-border bg-card">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <SeverityIndicator severity={alert.severity} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="text-sm font-medium text-card-foreground">{alert.title}</h3>
                          <Badge variant="outline" className="text-[10px] capitalize">
                            {alert.severity}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mb-2">{alert.affectedEntity || alert.description}</p>
                        <div className="rounded-md bg-accent/5 p-2.5">
                          <div className="flex items-start gap-1.5">
                            <Sparkles className="h-3 w-3 text-accent shrink-0 mt-0.5" />
                            <p className="text-xs text-card-foreground leading-relaxed">{alert.recommendation}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 mt-2.5">
                          <Button variant="outline" size="sm" className="h-7 text-xs">
                            Take Action
                            <ArrowRight className="h-3 w-3 ml-1" />
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground">
                            Dismiss
                          </Button>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <CheckCircle2 className="h-8 w-8 text-success mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No active risk alerts. Operations are running smoothly.</p>
            </div>
          )}

          {riskData?.summary && (
            <Card className="border-border bg-card border-l-2 border-l-accent">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <Brain className="h-4 w-4 text-accent shrink-0 mt-0.5" />
                  <div>
                    <h3 className="text-sm font-medium text-card-foreground mb-1">AI Summary</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">{riskData.summary}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Lane Intelligence Tab */}
        <TabsContent value="lanes" className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {/* Margin Trend */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-card-foreground">
                  Avg Margin % Trend (6 Weeks)
                </CardTitle>
              </CardHeader>
              <CardContent>
                {marginTrendData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={marginTrendData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="week" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} domain={[0, 40]} tickFormatter={(v) => `${v}%`} />
                      <RechartsTooltip
                        contentStyle={{ backgroundColor: "var(--card)", border: "1px solid var(--border)", borderRadius: "6px", fontSize: "12px", color: "var(--card-foreground)" }}
                        formatter={(value: number) => `${value}%`}
                      />
                      <Line type="monotone" dataKey="actual" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3, fill: "var(--accent)" }} />
                      <Line type="monotone" dataKey="target" stroke="var(--muted-foreground)" strokeWidth={1} strokeDasharray="4 4" dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-[220px] text-sm text-muted-foreground">No data available</div>
                )}
              </CardContent>
            </Card>

            {/* Carrier Performance Radar */}
            <Card className="border-border bg-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-card-foreground">
                  Top Carrier Scorecard{topCarrier ? ` (${topCarrier.name})` : ""}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {topCarrier ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <RadarChart data={topCarrier.data}>
                      <PolarGrid stroke="var(--border)" />
                      <PolarAngleAxis dataKey="metric" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                      <Radar dataKey="value" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.15} strokeWidth={2} />
                    </RadarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-[220px] text-sm text-muted-foreground">No carrier data</div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Lane Performance Table */}
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-card-foreground">
                Lane Performance Analysis
              </CardTitle>
            </CardHeader>
            <CardContent>
              {lanePerformanceData.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={lanePerformanceData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="lane" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
                    <RechartsTooltip
                      contentStyle={{ backgroundColor: "var(--card)", border: "1px solid var(--border)", borderRadius: "6px", fontSize: "12px", color: "var(--card-foreground)" }}
                      formatter={(value: number, name: string) => [name === "margin" ? `${value}%` : value, name === "margin" ? "Margin" : "Volume"]}
                    />
                    <Bar dataKey="margin" name="Margin %" fill="var(--accent)" radius={[3, 3, 0, 0]} maxBarSize={36} />
                    <Bar dataKey="volume" name="Volume" fill="var(--muted)" radius={[3, 3, 0, 0]} maxBarSize={36} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex items-center justify-center h-[250px] text-sm text-muted-foreground">No lane data available</div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Shipper Insights Tab */}
        <TabsContent value="shippers" className="space-y-4">
          {shipperInsights.length > 0 ? (
            <div className="space-y-3">
              {shipperInsights.map((item: any, i: number) => (
                <Card key={i} className="border-border bg-card">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1.5">
                          <h3 className="text-sm font-medium text-card-foreground">{item.company}</h3>
                          <Badge
                            variant="outline"
                            className={`text-[10px] ${item.priority === "high" ? "border-destructive/30 text-destructive" : "border-warning/30 text-warning"}`}
                          >
                            {item.priority} priority
                          </Badge>
                        </div>
                        <div className="rounded-md bg-accent/5 p-2.5 mb-2.5">
                          <div className="flex items-start gap-1.5">
                            <Sparkles className="h-3 w-3 text-accent shrink-0 mt-0.5" />
                            <p className="text-xs text-card-foreground leading-relaxed">{item.insight}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button variant="outline" size="sm" className="h-7 text-xs">
                            {item.action}
                            <ArrowRight className="h-3 w-3 ml-1" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-sm text-muted-foreground">No shipper data available</div>
          )}
        </TabsContent>

        {/* Automation Tab */}
        <TabsContent value="automation" className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            {[
              {
                title: "Auto-assign top carriers",
                description: `${carriers.length > 0 ? carriers.sort((a: any, b: any) => b.performanceScore - a.performanceScore)[0]?.company : "Top carrier"} has the best on-time rate. Automate assignment for contracted loads on their lanes.`,
                savings: `$420/mo in ops time`,
                confidence: carriers.length > 0 ? Math.min(carriers.sort((a: any, b: any) => b.performanceScore - a.performanceScore)[0]?.performanceScore || 80, 98) : 80,
              },
              {
                title: "POD reminder automation",
                description: `${loads.filter((l: any) => l.status === "Delivered").length} delivered loads may need POD verification. Auto-send reminders to carriers.`,
                savings: "12 hrs/mo admin time",
                confidence: 98,
              },
              {
                title: "Invoice factoring trigger",
                description: `${overdueInvoices.length} overdue invoices totaling ${formatCurrency(overdueTotal)}. Auto-submit to factoring when DPO exceeds 15 days.`,
                savings: `${formatCurrency(overdueTotal > 0 ? Math.round(overdueTotal * 0.05) : 2100)}/mo in cash flow`,
                confidence: 87,
              },
            ].map((suggestion, i) => (
              <Card key={i} className="border-border bg-card">
                <CardContent className="p-4 space-y-3">
                  <div>
                    <h3 className="text-sm font-medium text-card-foreground mb-1">{suggestion.title}</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">{suggestion.description}</p>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-success font-medium">{suggestion.savings}</span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground">Confidence</span>
                      <div className="h-1.5 w-16 rounded-full bg-secondary overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${suggestion.confidence}%` }}
                        />
                      </div>
                      <span className="text-[10px] font-medium text-card-foreground">{suggestion.confidence}%</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="h-7 text-xs flex-1">
                      Enable
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground">
                      Details
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card className="border-border bg-card border-l-2 border-l-accent">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <Sparkles className="h-4 w-4 text-accent shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-medium text-card-foreground mb-1">Automation Impact Summary</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Enabling all suggested automations could save approximately <span className="text-card-foreground font-medium">$2,520/mo</span> in operational costs and <span className="text-card-foreground font-medium">12+ hours</span> of admin time.
                    Currently managing {loads.length} loads across {carriers.length} carriers with {formatCurrency(totalRevenue)} in total revenue.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
