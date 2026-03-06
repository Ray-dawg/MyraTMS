"use client"

import { useState } from "react"
import useSWR, { mutate } from "swr"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import {
  AlertTriangle,
  Eye,
  CheckCircle,
  ExternalLink,
  RefreshCw,
  Loader2,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useRouter } from "next/navigation"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Exception {
  id: string
  load_id: string | null
  carrier_id: string | null
  type: string
  severity: "critical" | "high" | "medium" | "low"
  title: string
  detail: string
  status: "active" | "acknowledged" | "resolved"
  acknowledged_at: string | null
  resolved_at: string | null
  created_at: string
  reference_number?: string
  origin_city?: string
  dest_city?: string
  carrier_name?: string
}

interface ExceptionCounts {
  critical: number
  high: number
  medium: number
  low: number
  total: number
}

interface ExceptionsResponse {
  exceptions: Exception[]
  counts: ExceptionCounts
}

// ---------------------------------------------------------------------------
// Fetcher & Hook
// ---------------------------------------------------------------------------

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`API Error: ${res.status}`)
  return res.json()
}

export function useExceptions(
  filter: { status?: string; severity?: string } = {}
) {
  const params = new URLSearchParams()
  if (filter.status) params.set("status", filter.status)
  if (filter.severity) params.set("severity", filter.severity)
  const qs = params.toString()

  return useSWR<ExceptionsResponse>(
    `/api/exceptions${qs ? `?${qs}` : ""}`,
    fetcher,
    { refreshInterval: 60000, revalidateOnFocus: false }
  )
}

// For the topbar badge — just counts
export function useExceptionCounts() {
  return useSWR<ExceptionsResponse>(
    "/api/exceptions?status=active",
    fetcher,
    { refreshInterval: 60000, revalidateOnFocus: false, dedupingInterval: 10000 }
  )
}

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

const severityColor: Record<string, string> = {
  critical: "bg-red-500/15 text-red-600 border-red-500/30",
  high: "bg-orange-500/15 text-orange-600 border-orange-500/30",
  medium: "bg-yellow-500/15 text-yellow-700 border-yellow-500/30",
  low: "bg-blue-500/15 text-blue-600 border-blue-500/30",
}

const severityDot: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-blue-500",
}

function timeAgo(timestamp: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(timestamp).getTime()) / 1000
  )
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

const tabs = [
  { key: "all", label: "All" },
  { key: "critical", label: "Critical" },
  { key: "high", label: "High" },
  { key: "medium", label: "Medium" },
  { key: "low", label: "Low" },
] as const

// ---------------------------------------------------------------------------
// Alert Center Panel
// ---------------------------------------------------------------------------

export function AlertCenter() {
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<string>("all")
  const [showResolved, setShowResolved] = useState(false)
  const [running, setRunning] = useState(false)
  const router = useRouter()

  const status = showResolved ? "all" : "active"
  const severity = activeTab !== "all" ? activeTab : undefined
  const { data, isLoading } = useExceptions({ status, severity })
  const { data: countData } = useExceptionCounts()

  const exceptions = data?.exceptions || []
  const counts = countData?.counts || { critical: 0, high: 0, medium: 0, low: 0, total: 0 }
  const urgentCount = counts.critical + counts.high

  const handleRunDetection = async () => {
    setRunning(true)
    try {
      await fetch("/api/exceptions/detect", { method: "POST" })
      mutate((key: unknown) => typeof key === "string" && key.startsWith("/api/exceptions"))
    } finally {
      setRunning(false)
    }
  }

  const handleAction = async (id: string, action: "acknowledge" | "resolve") => {
    // Optimistic update
    const key = `/api/exceptions?status=${status}${severity ? `&severity=${severity}` : ""}`
    mutate(
      key,
      (current: ExceptionsResponse | undefined) => {
        if (!current) return current
        return {
          ...current,
          exceptions: current.exceptions.map((e) =>
            e.id === id
              ? {
                  ...e,
                  status: action === "acknowledge" ? "acknowledged" as const : "resolved" as const,
                  ...(action === "acknowledge"
                    ? { acknowledged_at: new Date().toISOString() }
                    : { resolved_at: new Date().toISOString() }),
                }
              : e
          ),
        }
      },
      false
    )

    await fetch(`/api/exceptions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    })

    // Revalidate all exception keys
    mutate((k: unknown) => typeof k === "string" && k.startsWith("/api/exceptions"))
  }

  const tabCount = (key: string) => {
    if (key === "all") return counts.total
    return counts[key as keyof ExceptionCounts] || 0
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8 text-muted-foreground hover:text-foreground"
        >
          <AlertTriangle className="h-4 w-4" />
          {urgentCount > 0 && (
            <span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">
              {urgentCount > 99 ? "99+" : urgentCount}
            </span>
          )}
          <span className="sr-only">Alerts</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[480px] max-w-full p-0 flex flex-col">
        {/* Header */}
        <SheetHeader className="px-4 py-3 border-b border-border">
          <div className="flex items-center justify-between">
            <SheetTitle className="text-sm font-semibold">Alert Center</SheetTitle>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={handleRunDetection}
              disabled={running}
            >
              {running ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Run Detection
            </Button>
          </div>
        </SheetHeader>

        {/* Tabs */}
        <div className="flex gap-1 px-4 py-2 border-b border-border overflow-x-auto">
          {tabs.map((tab) => {
            const count = tabCount(tab.key)
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap",
                  activeTab === tab.key
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                )}
              >
                {tab.label}
                {count > 0 && (
                  <Badge
                    variant="secondary"
                    className={cn(
                      "h-4 min-w-[16px] px-1 text-[10px] font-semibold",
                      tab.key !== "all" && severityColor[tab.key]
                    )}
                  >
                    {count}
                  </Badge>
                )}
              </button>
            )
          })}
        </div>

        {/* Exception Cards */}
        <ScrollArea className="flex-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : exceptions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-4">
              <CheckCircle className="h-8 w-8 text-green-500 mb-2" />
              <p className="text-sm font-medium text-foreground">All clear</p>
              <p className="text-xs text-muted-foreground mt-1">No active exceptions</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {exceptions.map((exc) => (
                <div
                  key={exc.id}
                  className={cn(
                    "px-4 py-3",
                    exc.status === "acknowledged" && "bg-muted/30",
                    exc.status === "resolved" && "opacity-60"
                  )}
                >
                  <div className="flex items-start gap-3">
                    {/* Severity dot */}
                    <div className="mt-1.5 shrink-0">
                      <div
                        className={cn(
                          "h-2.5 w-2.5 rounded-full",
                          severityDot[exc.severity]
                        )}
                      />
                    </div>

                    <div className="flex-1 min-w-0">
                      {/* Title + severity badge */}
                      <div className="flex items-center gap-2 mb-0.5">
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] px-1.5 py-0 h-4 font-medium capitalize",
                            severityColor[exc.severity]
                          )}
                        >
                          {exc.severity}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">
                          {timeAgo(exc.created_at)}
                        </span>
                      </div>

                      <p className="text-xs font-medium text-foreground leading-relaxed mt-1">
                        {exc.title}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                        {exc.detail}
                      </p>

                      {/* Actions */}
                      {exc.status === "acknowledged" ? (
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-[10px] text-muted-foreground italic">
                            Acknowledged
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-[11px] text-green-600 hover:text-green-700 px-2"
                            onClick={() => handleAction(exc.id, "resolve")}
                          >
                            <CheckCircle className="h-3 w-3 mr-1" />
                            Resolve
                          </Button>
                        </div>
                      ) : exc.status === "resolved" ? (
                        <p className="text-[10px] text-muted-foreground italic mt-2">
                          Resolved {exc.resolved_at ? timeAgo(exc.resolved_at) : ""}
                        </p>
                      ) : (
                        <div className="flex items-center gap-1 mt-2">
                          {exc.load_id && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 text-[11px] px-2"
                              onClick={() => {
                                router.push(`/loads/${exc.load_id}`)
                                setOpen(false)
                              }}
                            >
                              <ExternalLink className="h-3 w-3 mr-1" />
                              View Load
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-[11px] px-2"
                            onClick={() => handleAction(exc.id, "acknowledge")}
                          >
                            <Eye className="h-3 w-3 mr-1" />
                            Acknowledge
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-[11px] text-green-600 hover:text-green-700 px-2"
                            onClick={() => handleAction(exc.id, "resolve")}
                          >
                            <CheckCircle className="h-3 w-3 mr-1" />
                            Resolve
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Footer toggle */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          <span className="text-[11px] text-muted-foreground">Show Resolved</span>
          <Switch
            checked={showResolved}
            onCheckedChange={setShowResolved}
            className="h-4 w-7"
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
