"use client"

import { useState, useMemo, useCallback } from "react"
import { useRouter } from "next/navigation"
import useSWR, { mutate } from "swr"
import { ShieldCheck, ShieldAlert, ShieldX, AlertTriangle, RefreshCw, Clock, CheckCircle2, Search, XCircle, ChevronRight, Wifi, WifiOff } from "lucide-react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { toast } from "sonner"

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`API Error: ${res.status}`)
  return res.json()
}

const formatCurrency = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

interface CarrierRow {
  id: string
  company: string
  mc_number: string
  dot_number: string
  authority_status: string
  insurance_expiry: string
  insurance_status?: string
  liability_insurance: number
  cargo_insurance: number
  safety_rating: string
  vehicle_oos_percent: number
  driver_oos_percent: number
  last_fmcsa_sync: string
  performance_score?: number
  on_time_percent?: number
}

interface AlertRow {
  id: string
  carrier_id: string
  carrier_name: string
  mc_number: string
  type: string
  severity: string
  title: string
  description: string
  detected_at: string
  resolved: boolean
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null
  return Math.floor((new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
}

function complianceScore(c: CarrierRow): number {
  let score = 100
  if (c.authority_status !== "Active") score -= 40
  const days = daysUntil(c.insurance_expiry)
  if (days !== null && days < 0) score -= 30
  else if (days !== null && days <= 30) score -= 10
  if (c.safety_rating === "Unsatisfactory") score -= 25
  else if (c.safety_rating === "Conditional") score -= 10
  if (c.vehicle_oos_percent > 20) score -= 10
  if (c.driver_oos_percent > 5.5) score -= 10
  return Math.max(0, score)
}

function scoreColor(score: number): string {
  if (score >= 80) return "text-emerald-400"
  if (score >= 50) return "text-amber-400"
  return "text-red-400"
}

function scoreBg(score: number): string {
  if (score >= 80) return "bg-emerald-500"
  if (score >= 50) return "bg-amber-500"
  return "bg-red-500"
}

function insuranceStatus(expiry: string | null): string {
  const days = daysUntil(expiry)
  if (days === null) return "Unknown"
  if (days < 0) return "Expired"
  if (days <= 30) return "Expiring"
  return "Active"
}

function insuranceBadgeStyle(status: string): string {
  if (status === "Active") return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
  if (status === "Expiring") return "bg-amber-500/10 text-amber-400 border-amber-500/20"
  return "bg-red-500/10 text-red-400 border-red-500/20"
}

const severityStyles: Record<string, string> = {
  critical: "bg-red-500/10 text-red-400 border-red-500/20",
  warning: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  info: "bg-blue-500/10 text-blue-400 border-blue-500/20",
}

const severityIcon: Record<string, React.ReactNode> = {
  critical: <XCircle className="h-4 w-4 text-red-400" />,
  warning: <AlertTriangle className="h-4 w-4 text-amber-400" />,
  info: <Clock className="h-4 w-4 text-blue-400" />,
}

export default function CompliancePage() {
  const [search, setSearch] = useState("")
  const [verifying, setVerifying] = useState(false)
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  const router = useRouter()

  // Fetch carriers from real API
  const { data: carriersData, isLoading: carriersLoading } = useSWR<CarrierRow[]>("/api/carriers", fetcher)

  // Fetch compliance alerts from real API
  const { data: alertsData, isLoading: alertsLoading } = useSWR<{ alerts: AlertRow[]; summary: { total: number; critical: number; warnings: number } }>("/api/compliance/alerts", fetcher)

  const carriers = carriersData || []
  const alerts = alertsData?.alerts || []

  const carriersWithScores = useMemo(() =>
    carriers
      .map((c) => ({
        ...c,
        score: complianceScore(c),
        daysLeft: daysUntil(c.insurance_expiry),
        ins_status: insuranceStatus(c.insurance_expiry),
      }))
      .filter((c) => !search || c.company.toLowerCase().includes(search.toLowerCase()) || c.mc_number?.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => a.score - b.score),
    [carriers, search]
  )

  const compliantCount = carriersWithScores.filter((c) => c.score >= 80).length
  const warningCount = carriersWithScores.filter((c) => c.score >= 50 && c.score < 80).length
  const criticalCount = carriersWithScores.filter((c) => c.score < 50).length
  const expiringSoon = carriersWithScores.filter((c) => c.daysLeft !== null && c.daysLeft > 0 && c.daysLeft <= 30).length

  const handleBatchVerify = useCallback(async () => {
    setVerifying(true)
    try {
      const res = await fetch("/api/compliance/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success("Batch verification complete", {
          description: `${data.summary?.total || 0} carriers verified. ${data.summary?.non_compliant || 0} non-compliant found.${data.api_connected ? " (Live FMCSA)" : " (Database only)"}`,
        })
        // Revalidate data
        mutate("/api/carriers")
        mutate("/api/compliance/alerts")
      } else {
        toast.error("Batch verification failed", { description: data.error })
      }
    } catch (err) {
      toast.error("Batch verification failed", { description: "Network error" })
    } finally {
      setVerifying(false)
    }
  }, [])

  const handleVerifySingle = useCallback(async (carrierId: string) => {
    setVerifyingId(carrierId)
    try {
      const res = await fetch("/api/compliance/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ carrierId }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(`Verified ${data.company}`, {
          description: data.compliant ? "Carrier is compliant" : "Compliance issues found",
        })
        mutate("/api/carriers")
        mutate("/api/compliance/alerts")
      } else {
        toast.error("Verification failed", { description: data.error })
      }
    } catch {
      toast.error("Verification failed")
    } finally {
      setVerifyingId(null)
    }
  }, [])

  const resolveAlert = useCallback(async (alertId: string) => {
    try {
      const res = await fetch("/api/compliance/alerts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: alertId, resolved: true }),
      })
      if (res.ok) {
        toast.success("Alert resolved")
        mutate("/api/compliance/alerts")
      } else {
        toast.error("Failed to resolve alert")
      }
    } catch {
      toast.error("Failed to resolve alert")
    }
  }, [])

  const isLoading = carriersLoading || alertsLoading

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Carrier Compliance</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Monitor carrier authority, insurance, and safety compliance via FMCSA</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleBatchVerify} disabled={verifying || isLoading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${verifying ? "animate-spin" : ""}`} />
            {verifying ? "Verifying..." : "Verify All"}
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card className="bg-card border-border"><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><ShieldCheck className="h-4 w-4 text-emerald-400" /><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Compliant</p></div><p className="text-2xl font-semibold font-mono text-emerald-400">{isLoading ? "--" : compliantCount}</p><p className="text-[11px] text-muted-foreground mt-0.5">Score 80+</p></CardContent></Card>
        <Card className="bg-card border-border"><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><ShieldAlert className="h-4 w-4 text-amber-400" /><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Warnings</p></div><p className="text-2xl font-semibold font-mono text-amber-400">{isLoading ? "--" : warningCount}</p><p className="text-[11px] text-muted-foreground mt-0.5">Score 50-79</p></CardContent></Card>
        <Card className="bg-card border-border"><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><ShieldX className="h-4 w-4 text-red-400" /><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Non-Compliant</p></div><p className="text-2xl font-semibold font-mono text-red-400">{isLoading ? "--" : criticalCount}</p><p className="text-[11px] text-muted-foreground mt-0.5">Score below 50</p></CardContent></Card>
        <Card className="bg-card border-border"><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><Clock className="h-4 w-4 text-blue-400" /><p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Expiring Soon</p></div><p className="text-2xl font-semibold font-mono text-foreground">{isLoading ? "--" : expiringSoon}</p><p className="text-[11px] text-muted-foreground mt-0.5">Insurance within 30 days</p></CardContent></Card>
      </div>

      <Tabs defaultValue="alerts">
        <TabsList className="bg-secondary/30 h-9">
          <TabsTrigger value="alerts" className="text-xs">Active Alerts ({alerts.length})</TabsTrigger>
          <TabsTrigger value="carriers" className="text-xs">All Carriers</TabsTrigger>
          <TabsTrigger value="watchlist" className="text-xs">Watchlist</TabsTrigger>
        </TabsList>

        {/* Alerts Tab */}
        <TabsContent value="alerts" className="mt-4 space-y-3">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <RefreshCw className="h-8 w-8 mb-3 opacity-40 animate-spin" />
              <p className="text-sm">Loading alerts...</p>
            </div>
          ) : alerts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <CheckCircle2 className="h-8 w-8 mb-3 opacity-40" />
              <p className="text-sm">All alerts resolved</p>
            </div>
          ) : (
            alerts.map((alert) => (
              <Card key={alert.id} className="bg-card border-border">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    {severityIcon[alert.severity] || severityIcon.info}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-foreground">{alert.title}</span>
                        <Badge variant="outline" className={`text-[10px] border ${severityStyles[alert.severity] || severityStyles.info}`}>{alert.severity}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{alert.description}</p>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="text-[10px] text-muted-foreground">{alert.carrier_name} ({alert.mc_number})</span>
                        <span className="text-[10px] text-muted-foreground">Detected {new Date(alert.detected_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => router.push(`/carriers/${alert.carrier_id}`)}>View Carrier<ChevronRight className="h-3 w-3 ml-1" /></Button>
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => resolveAlert(alert.id)}>Resolve</Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        {/* All Carriers Tab */}
        <TabsContent value="carriers" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input placeholder="Search carrier or MC#..." className="pl-9 h-9 bg-secondary/30 border-border text-sm" value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                  <RefreshCw className="h-6 w-6 mb-3 opacity-40 animate-spin" />
                  <p className="text-sm">Loading carriers...</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="border-b-border hover:bg-transparent">
                      <TableHead className="text-[11px] font-medium text-muted-foreground">Carrier</TableHead>
                      <TableHead className="text-[11px] font-medium text-muted-foreground">MC #</TableHead>
                      <TableHead className="text-[11px] font-medium text-muted-foreground">Score</TableHead>
                      <TableHead className="text-[11px] font-medium text-muted-foreground">Authority</TableHead>
                      <TableHead className="text-[11px] font-medium text-muted-foreground">Insurance</TableHead>
                      <TableHead className="text-[11px] font-medium text-muted-foreground">Safety Rating</TableHead>
                      <TableHead className="text-[11px] font-medium text-muted-foreground">Liability</TableHead>
                      <TableHead className="text-[11px] font-medium text-muted-foreground">Vehicle OOS%</TableHead>
                      <TableHead className="text-[11px] font-medium text-muted-foreground">Driver OOS%</TableHead>
                      <TableHead className="text-[11px] font-medium text-muted-foreground">Last Verified</TableHead>
                      <TableHead className="text-[11px] font-medium text-muted-foreground">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {carriersWithScores.map((c) => (
                      <TableRow key={c.id} className="cursor-pointer hover:bg-secondary/30 transition-colors border-b-border" onClick={() => router.push(`/carriers/${c.id}`)}>
                        <TableCell><span className="text-xs font-medium text-foreground">{c.company}</span></TableCell>
                        <TableCell><span className="text-xs font-mono text-muted-foreground">{c.mc_number}</span></TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-1.5 rounded-full bg-secondary overflow-hidden"><div className={`h-full rounded-full ${scoreBg(c.score)}`} style={{ width: `${c.score}%` }} /></div>
                            <span className={`text-xs font-mono font-medium ${scoreColor(c.score)}`}>{c.score}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[10px] border ${c.authority_status === "Active" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-red-500/10 text-red-400 border-red-500/20"}`}>{c.authority_status || "Unknown"}</Badge>
                        </TableCell>
                        <TableCell>
                          <div>
                            <Badge variant="outline" className={`text-[10px] border ${insuranceBadgeStyle(c.ins_status)}`}>{c.ins_status}</Badge>
                            {c.daysLeft !== null && c.daysLeft > 0 && c.daysLeft <= 60 && <span className="text-[10px] text-muted-foreground ml-1.5">{c.daysLeft}d left</span>}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[10px] border ${c.safety_rating === "Satisfactory" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : c.safety_rating === "Conditional" ? "bg-amber-500/10 text-amber-400 border-amber-500/20" : c.safety_rating === "Unsatisfactory" ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-neutral-500/10 text-neutral-400 border-neutral-500/20"}`}>{c.safety_rating || "Not Rated"}</Badge>
                        </TableCell>
                        <TableCell><span className="text-xs font-mono text-muted-foreground">{formatCurrency(c.liability_insurance || 0)}</span></TableCell>
                        <TableCell><span className={`text-xs font-mono ${(c.vehicle_oos_percent || 0) > 20 ? "text-red-400" : "text-muted-foreground"}`}>{c.vehicle_oos_percent || 0}%</span></TableCell>
                        <TableCell><span className={`text-xs font-mono ${(c.driver_oos_percent || 0) > 5.5 ? "text-amber-400" : "text-muted-foreground"}`}>{c.driver_oos_percent || 0}%</span></TableCell>
                        <TableCell><span className="text-[10px] text-muted-foreground">{c.last_fmcsa_sync ? new Date(c.last_fmcsa_sync).toLocaleDateString() : "Never"}</span></TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            disabled={verifyingId === c.id}
                            onClick={(e) => { e.stopPropagation(); handleVerifySingle(c.id) }}
                          >
                            <RefreshCw className={`h-3 w-3 mr-1 ${verifyingId === c.id ? "animate-spin" : ""}`} />
                            {verifyingId === c.id ? "..." : "Verify"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Watchlist Tab */}
        <TabsContent value="watchlist" className="mt-4">
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Carriers requiring attention: insurance expiring within 30 days, low safety scores, or non-compliant authority.</p>
            {isLoading ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <RefreshCw className="h-6 w-6 mb-3 opacity-40 animate-spin" />
                <p className="text-sm">Loading watchlist...</p>
              </div>
            ) : (
              <>
                {carriersWithScores.filter((c) => c.score < 80).map((c) => (
                  <Card key={c.id} className="bg-card border-border cursor-pointer hover:bg-secondary/30 transition-colors" onClick={() => router.push(`/carriers/${c.id}`)}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${c.score < 50 ? "bg-red-500/10" : "bg-amber-500/10"}`}>
                            {c.score < 50 ? <ShieldX className="h-4 w-4 text-red-400" /> : <ShieldAlert className="h-4 w-4 text-amber-400" />}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-foreground">{c.company}</p>
                            <p className="text-[11px] text-muted-foreground">{c.mc_number} | {c.dot_number}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <div className="text-right">
                            <p className={`text-lg font-semibold font-mono ${scoreColor(c.score)}`}>{c.score}</p>
                            <p className="text-[10px] text-muted-foreground">Compliance Score</p>
                          </div>
                          <div className="flex flex-wrap gap-1.5 max-w-[300px]">
                            {c.authority_status !== "Active" && <Badge variant="outline" className="text-[10px] border bg-red-500/10 text-red-400 border-red-500/20">Authority {c.authority_status}</Badge>}
                            {c.ins_status === "Expired" && <Badge variant="outline" className="text-[10px] border bg-red-500/10 text-red-400 border-red-500/20">Insurance Expired</Badge>}
                            {c.ins_status === "Expiring" && <Badge variant="outline" className="text-[10px] border bg-amber-500/10 text-amber-400 border-amber-500/20">Insurance {c.daysLeft}d</Badge>}
                            {c.safety_rating === "Unsatisfactory" && <Badge variant="outline" className="text-[10px] border bg-red-500/10 text-red-400 border-red-500/20">Unsatisfactory Safety</Badge>}
                            {c.safety_rating === "Conditional" && <Badge variant="outline" className="text-[10px] border bg-amber-500/10 text-amber-400 border-amber-500/20">Conditional Safety</Badge>}
                            {(c.driver_oos_percent || 0) > 5.5 && <Badge variant="outline" className="text-[10px] border bg-amber-500/10 text-amber-400 border-amber-500/20">High Driver OOS</Badge>}
                          </div>
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
                {carriersWithScores.filter((c) => c.score < 80).length === 0 && (
                  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                    <ShieldCheck className="h-8 w-8 mb-3 opacity-40" />
                    <p className="text-sm">All carriers are compliant</p>
                  </div>
                )}
              </>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
