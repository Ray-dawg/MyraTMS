"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { RefreshCw, AlertTriangle, CheckCircle2, Clock, TruckIcon, ChevronDown, ChevronUp } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface BriefingData {
  date: string
  pickups: Array<{
    id: string
    reference_number: string
    origin_city: string
    origin: string
    shipper_name: string
    carrier_name: string
    pickup_window_start: string | null
    pickup_window_end: string | null
    status: string
    is_late: boolean
  }>
  deliveries: Array<{
    id: string
    reference_number: string
    dest_city: string
    destination: string
    shipper_name: string
    carrier_name: string
    delivery_window_start: string | null
    current_eta: string | null
    status: string
    is_late: boolean
  }>
  inTransit: {
    count: number
    loads: Array<{
      id: string
      reference_number: string
      origin_city: string
      dest_city: string
      carrier_name: string
      current_lat: number | null
      current_lng: number | null
      current_eta: string | null
    }>
  }
  exceptions: Array<{
    id: string
    type: string
    severity: string
    title: string
    load_id: string
    created_at: string
  }>
  uncovered: Array<{
    id: string
    reference_number: string
    origin_city: string
    dest_city: string
    equipment: string
    pickup_date: string
    shipper_name: string
  }>
  yesterday: {
    deliveredCount: number
    onTimeRate: number
    totalRevenue: number
    totalMargin: number
    avgMarginPct: number
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return "TBD"
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00")
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  })
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n)
}

function getGreeting(): string {
  const h = new Date().getHours()
  if (h < 12) return "Good morning"
  if (h < 17) return "Good afternoon"
  return "Good evening"
}

export default function DispatchBriefingPage() {
  const router = useRouter()
  const today = new Date().toISOString().split("T")[0]
  const [selectedDate, setSelectedDate] = useState(today)
  const [data, setData] = useState<BriefingData | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAllTransit, setShowAllTransit] = useState(false)

  const fetchBriefing = useCallback(async (date: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/dispatch/briefing?date=${date}`)
      if (res.ok) {
        setData(await res.json())
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchBriefing(selectedDate)
  }, [selectedDate, fetchBriefing])

  const needAttentionCount =
    (data?.exceptions.length ?? 0) + (data?.uncovered.length ?? 0)

  return (
    <div className="space-y-6 p-6">
      {/* TOP BAR */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {getGreeting()}
          </h1>
          <p className="text-muted-foreground">
            {formatDate(selectedDate)}
            {data && !loading && (
              <span className="ml-2">
                &middot; {data.pickups.length} pickups &middot;{" "}
                {data.deliveries.length} deliveries
                {needAttentionCount > 0 && (
                  <span className="text-destructive font-medium">
                    {" "}
                    &middot; {needAttentionCount} need attention
                  </span>
                )}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchBriefing(selectedDate)}
            disabled={loading}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <RefreshCw className="mr-2 h-5 w-5 animate-spin" />
          Loading briefing...
        </div>
      ) : data ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* SECTION A — Today's Pickups */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <TruckIcon className="h-4 w-4" />
                Today&apos;s Pickups
                <Badge variant="secondary" className="ml-auto">
                  {data.pickups.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.pickups.length === 0 ? (
                <p className="px-6 pb-4 text-sm text-muted-foreground">
                  No pickups scheduled
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="px-4 py-2 font-medium">Time</th>
                        <th className="px-4 py-2 font-medium">Load #</th>
                        <th className="px-4 py-2 font-medium">Origin</th>
                        <th className="px-4 py-2 font-medium">Shipper</th>
                        <th className="px-4 py-2 font-medium">Carrier</th>
                        <th className="px-4 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.pickups.map((p) => (
                        <tr
                          key={p.id}
                          onClick={() => router.push(`/loads/${p.id}`)}
                          className={cn(
                            "cursor-pointer border-b transition-colors hover:bg-muted/50",
                            p.is_late && "border-l-2 border-l-destructive bg-destructive/5"
                          )}
                        >
                          <td className="px-4 py-2 whitespace-nowrap">
                            {formatTime(p.pickup_window_start)}
                          </td>
                          <td className="px-4 py-2 font-mono text-xs">
                            {p.reference_number || p.id}
                          </td>
                          <td className="px-4 py-2">{p.origin_city || p.origin}</td>
                          <td className="px-4 py-2 truncate max-w-[120px]">
                            {p.shipper_name}
                          </td>
                          <td className="px-4 py-2 truncate max-w-[120px]">
                            {p.carrier_name || "—"}
                          </td>
                          <td className="px-4 py-2">
                            <StatusBadge status={p.status} isLate={p.is_late} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* SECTION B — Today's Deliveries */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Today&apos;s Deliveries
                <Badge variant="secondary" className="ml-auto">
                  {data.deliveries.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.deliveries.length === 0 ? (
                <p className="px-6 pb-4 text-sm text-muted-foreground">
                  No deliveries scheduled
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="px-4 py-2 font-medium">ETA</th>
                        <th className="px-4 py-2 font-medium">Load #</th>
                        <th className="px-4 py-2 font-medium">Destination</th>
                        <th className="px-4 py-2 font-medium">Shipper</th>
                        <th className="px-4 py-2 font-medium">Carrier</th>
                        <th className="px-4 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.deliveries.map((d) => (
                        <tr
                          key={d.id}
                          onClick={() => router.push(`/loads/${d.id}`)}
                          className={cn(
                            "cursor-pointer border-b transition-colors hover:bg-muted/50",
                            d.is_late && "bg-yellow-500/10"
                          )}
                        >
                          <td className="px-4 py-2 whitespace-nowrap">
                            {formatTime(d.current_eta || d.delivery_window_start)}
                          </td>
                          <td className="px-4 py-2 font-mono text-xs">
                            {d.reference_number || d.id}
                          </td>
                          <td className="px-4 py-2">{d.dest_city || d.destination}</td>
                          <td className="px-4 py-2 truncate max-w-[120px]">
                            {d.shipper_name}
                          </td>
                          <td className="px-4 py-2 truncate max-w-[120px]">
                            {d.carrier_name || "—"}
                          </td>
                          <td className="px-4 py-2">
                            <StatusBadge status={d.status} isLate={d.is_late} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* SECTION C — In Transit */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green-500" />
                </span>
                In Transit
                <Badge variant="secondary" className="ml-auto">
                  {data.inTransit.count} loads moving
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.inTransit.count === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No loads currently in transit
                </p>
              ) : (
                <div className="space-y-2">
                  {(showAllTransit
                    ? data.inTransit.loads
                    : data.inTransit.loads.slice(0, 5)
                  ).map((l) => (
                    <div
                      key={l.id}
                      onClick={() => router.push(`/loads/${l.id}`)}
                      className="flex items-center justify-between rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-xs text-muted-foreground">
                          {l.reference_number || l.id}
                        </span>
                        <span>
                          {l.origin_city} &rarr; {l.dest_city}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-muted-foreground">
                        <span className="truncate max-w-[100px]">
                          {l.carrier_name}
                        </span>
                        <span className="whitespace-nowrap text-xs">
                          ETA {formatTime(l.current_eta)}
                        </span>
                      </div>
                    </div>
                  ))}
                  {data.inTransit.loads.length > 5 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full text-muted-foreground"
                      onClick={() => setShowAllTransit(!showAllTransit)}
                    >
                      {showAllTransit ? (
                        <>
                          <ChevronUp className="mr-1 h-3 w-3" /> Show less
                        </>
                      ) : (
                        <>
                          <ChevronDown className="mr-1 h-3 w-3" /> Show all{" "}
                          {data.inTransit.loads.length} loads
                        </>
                      )}
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* SECTION F — Yesterday's Performance */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                Yesterday&apos;s Performance
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.yesterday.deliveredCount === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No deliveries recorded yesterday
                </p>
              ) : (
                <div className="flex flex-wrap gap-3">
                  <StatPill
                    label="Loads Delivered"
                    value={String(data.yesterday.deliveredCount)}
                  />
                  <StatPill
                    label="On-Time %"
                    value={`${Math.round(data.yesterday.onTimeRate * 100)}%`}
                    className={cn(
                      data.yesterday.onTimeRate >= 0.85
                        ? "text-green-600 dark:text-green-400"
                        : data.yesterday.onTimeRate >= 0.7
                          ? "text-yellow-600 dark:text-yellow-400"
                          : "text-red-600 dark:text-red-400"
                    )}
                  />
                  <StatPill
                    label="Revenue"
                    value={formatCurrency(data.yesterday.totalRevenue)}
                  />
                  <StatPill
                    label="Margin"
                    value={formatCurrency(data.yesterday.totalMargin)}
                  />
                  <StatPill
                    label="Margin %"
                    value={`${data.yesterday.avgMarginPct}%`}
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {/* SECTION D — Needs Attention (col-span-2) */}
          <Card className="lg:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="h-4 w-4" />
                Needs Attention
                {data.exceptions.length > 0 && (
                  <Badge variant="destructive" className="ml-auto">
                    {data.exceptions.length}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.exceptions.length === 0 ? (
                <div className="rounded-md bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:text-green-400 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" />
                  All Clear
                </div>
              ) : (
                <div className="space-y-2">
                  {data.exceptions.map((ex) => (
                    <div
                      key={ex.id}
                      className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                    >
                      <div className="flex items-center gap-3">
                        <Badge
                          variant={
                            ex.severity === "critical"
                              ? "destructive"
                              : "default"
                          }
                          className={cn(
                            ex.severity !== "critical" &&
                              "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/20"
                          )}
                        >
                          {ex.severity}
                        </Badge>
                        <span>{ex.title}</span>
                        <span className="text-xs text-muted-foreground">
                          {timeAgo(ex.created_at)}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => router.push(`/loads/${ex.load_id}`)}
                      >
                        View
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* SECTION E — Uncovered Loads (col-span-2) */}
          <Card
            className={cn(
              "lg:col-span-2",
              data.uncovered.length > 0 &&
                "border-amber-500/50 bg-amber-500/5"
            )}
          >
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Uncovered Loads
                {data.uncovered.length > 0 && (
                  <span className="ml-auto text-sm font-medium text-amber-600 dark:text-amber-400">
                    {data.uncovered.length} load{data.uncovered.length !== 1 && "s"} need carriers
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {data.uncovered.length === 0 ? (
                <div className="mx-6 mb-4 rounded-md bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:text-green-400 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" />
                  All Covered
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="px-4 py-2 font-medium">Pickup Date</th>
                        <th className="px-4 py-2 font-medium">Load #</th>
                        <th className="px-4 py-2 font-medium">Lane</th>
                        <th className="px-4 py-2 font-medium">Equipment</th>
                        <th className="px-4 py-2 font-medium">Shipper</th>
                        <th className="px-4 py-2 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.uncovered.map((u) => (
                        <tr key={u.id} className="border-b">
                          <td className="px-4 py-2 whitespace-nowrap">
                            {new Date(u.pickup_date + "T12:00:00").toLocaleDateString(
                              "en-US",
                              { month: "short", day: "numeric" }
                            )}
                          </td>
                          <td className="px-4 py-2 font-mono text-xs">
                            {u.reference_number || u.id}
                          </td>
                          <td className="px-4 py-2">
                            {u.origin_city} &rarr; {u.dest_city}
                          </td>
                          <td className="px-4 py-2">
                            {u.equipment || "—"}
                          </td>
                          <td className="px-4 py-2 truncate max-w-[120px]">
                            {u.shipper_name}
                          </td>
                          <td className="px-4 py-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                router.push(`/loads/${u.id}?tab=matching`)
                              }
                            >
                              Find Carrier
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  )
}

function StatusBadge({ status, isLate }: { status: string; isLate: boolean }) {
  if (isLate) {
    return (
      <Badge variant="destructive" className="text-xs">
        Late
      </Badge>
    )
  }
  const variants: Record<string, string> = {
    Dispatched: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20",
    "In Transit": "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/20",
    Delivered: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/20",
    Booked: "bg-muted text-muted-foreground",
  }
  return (
    <Badge variant="outline" className={cn("text-xs", variants[status])}>
      {status}
    </Badge>
  )
}

function StatPill({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className="flex-1 min-w-[100px] rounded-lg border bg-muted/30 px-4 py-3 text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-lg font-bold mt-0.5", className)}>{value}</p>
    </div>
  )
}
