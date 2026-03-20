"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { ChevronLeft, ChevronRight, CalendarDays, Truck, MapPin } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CalendarEvent {
  load_id: string
  reference_number: string
  event_type: "pickup" | "delivery"
  event_date: string
  origin_city: string
  dest_city: string
  carrier_name: string | null
  status: string
  assigned_rep: string | null
}

interface CalendarData {
  events: CalendarEvent[]
  availableReps: string[]
}

// ---------------------------------------------------------------------------
// Pure date helpers
// ---------------------------------------------------------------------------

function getWeekStart(date: Date): string {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  return d.toISOString().split("T")[0]
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00")
  d.setDate(d.getDate() + n)
  return d.toISOString().split("T")[0]
}

function formatWeekRange(weekStart: string): string {
  const start = new Date(weekStart + "T12:00:00")
  const end = new Date(weekStart + "T12:00:00")
  end.setDate(end.getDate() + 6)
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }
  const startStr = start.toLocaleDateString("en-US", opts)
  const endStr = end.toLocaleDateString("en-US", {
    ...opts,
    year: "numeric",
  })
  return `${startStr} - ${endStr}`
}

interface DayColumn {
  dateStr: string
  dayName: string
  dayNum: string
  isToday: boolean
}

function getDayColumns(weekStart: string): DayColumn[] {
  const today = new Date().toISOString().split("T")[0]
  const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
  return dayNames.map((dayName, i) => {
    const dateStr = addDays(weekStart, i)
    const d = new Date(dateStr + "T12:00:00")
    return {
      dateStr,
      dayName,
      dayNum: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      isToday: dateStr === today,
    }
  })
}

// ---------------------------------------------------------------------------
// Status color helpers
// ---------------------------------------------------------------------------

const statusBorderColor: Record<string, string> = {
  Booked: "border-l-slate-400",
  Dispatched: "border-l-blue-500",
  "In Transit": "border-l-amber-500",
  Delivered: "border-l-green-500",
}

const statusBadgeClass: Record<string, string> = {
  Booked: "bg-slate-500/15 text-slate-600 dark:text-slate-400 border-slate-500/20",
  Dispatched: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20",
  "In Transit": "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20",
  Delivered: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/20",
}

function getStatusBorderColor(status: string): string {
  if (status.toLowerCase().includes("exception")) return "border-l-red-500"
  return statusBorderColor[status] || "border-l-slate-400"
}

function getStatusBadgeClass(status: string): string {
  if (status.toLowerCase().includes("exception"))
    return "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/20"
  return statusBadgeClass[status] || "bg-muted text-muted-foreground"
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LoadCard({ event, onClick }: { event: CalendarEvent; onClick: () => void }) {
  const time = event.event_date
    ? new Date(event.event_date).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    : null

  return (
    <Card
      onClick={onClick}
      className={cn(
        "cursor-pointer border-l-4 p-2.5 transition-colors hover:bg-muted/50",
        getStatusBorderColor(event.status)
      )}
    >
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-1">
          <span className="font-mono text-xs text-muted-foreground truncate">
            {event.reference_number || event.load_id}
          </span>
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] px-1.5 py-0 shrink-0",
              event.event_type === "pickup"
                ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/20"
                : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
            )}
          >
            {event.event_type === "pickup" ? (
              <Truck className="mr-0.5 h-2.5 w-2.5" />
            ) : (
              <MapPin className="mr-0.5 h-2.5 w-2.5" />
            )}
            {event.event_type === "pickup" ? "Pickup" : "Delivery"}
          </Badge>
        </div>

        <p className="text-sm font-medium leading-tight truncate">
          {event.origin_city} &rarr; {event.dest_city}
        </p>

        {event.carrier_name && (
          <p className="text-xs text-muted-foreground truncate">
            {event.carrier_name}
          </p>
        )}

        <div className="flex items-center justify-between gap-1">
          <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0", getStatusBadgeClass(event.status))}>
            {event.status}
          </Badge>
          {time && time !== "Invalid Date" && (
            <span className="text-[10px] text-muted-foreground">{time}</span>
          )}
        </div>
      </div>
    </Card>
  )
}

function CalendarSkeleton() {
  return (
    <div className="overflow-x-auto">
      <div className="grid grid-cols-7 gap-px bg-border min-w-[900px]">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="bg-background p-2 space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function DispatchCalendarPage() {
  const router = useRouter()
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()))
  const [repFilter, setRepFilter] = useState("")
  const [data, setData] = useState<CalendarData | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchCalendar = useCallback(async (ws: string, rep: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ weekStart: ws })
      if (rep) params.set("rep", rep)
      const res = await fetch(`/api/dispatch/calendar?${params}`)
      if (!res.ok) {
        toast.error("Failed to load calendar data")
        return
      }
      setData(await res.json())
    } catch {
      toast.error("Failed to load calendar data")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCalendar(weekStart, repFilter)
  }, [weekStart, repFilter, fetchCalendar])

  const columns = getDayColumns(weekStart)

  // Group events by date
  const eventsByDate: Record<string, CalendarEvent[]> = {}
  if (data) {
    for (const ev of data.events) {
      const dateKey = ev.event_date ? ev.event_date.split("T")[0] : ""
      if (!eventsByDate[dateKey]) eventsByDate[dateKey] = []
      eventsByDate[dateKey].push(ev)
    }
  }

  const totalEvents = data?.events.length ?? 0

  return (
    <div className="space-y-4 p-6">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-bold tracking-tight">Dispatch Calendar</h1>
          {!loading && (
            <Badge variant="secondary" className="ml-1">
              {totalEvents} load{totalEvents !== 1 ? "s" : ""}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Rep filter */}
          <Select
            value={repFilter}
            onValueChange={(v) => setRepFilter(v === "all" ? "" : v)}
          >
            <SelectTrigger className="w-[160px] h-9 text-sm">
              <SelectValue placeholder="All reps" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reps</SelectItem>
              {(data?.availableReps ?? []).map((rep) => (
                <SelectItem key={rep} value={rep}>
                  {rep}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Week navigation */}
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => setWeekStart(addDays(weekStart, -7))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 text-sm"
              onClick={() => setWeekStart(getWeekStart(new Date()))}
            >
              Today
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => setWeekStart(addDays(weekStart, 7))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Week range label */}
      <p className="text-sm text-muted-foreground">{formatWeekRange(weekStart)}</p>

      {/* Calendar grid */}
      {loading && !data ? (
        <CalendarSkeleton />
      ) : (
        <div className="overflow-x-auto">
          <div className="grid grid-cols-7 gap-px bg-border min-w-[900px]">
            {columns.map((col) => {
              const dayEvents = eventsByDate[col.dateStr] || []
              return (
                <div
                  key={col.dateStr}
                  className={cn(
                    "bg-background flex flex-col",
                    col.isToday && "bg-accent/30"
                  )}
                >
                  {/* Column header */}
                  <div
                    className={cn(
                      "sticky top-0 z-10 border-b bg-background px-2 py-2 text-center",
                      col.isToday && "bg-accent/30"
                    )}
                  >
                    <p className="text-xs font-medium text-muted-foreground">
                      {col.dayName}
                    </p>
                    <p
                      className={cn(
                        "text-sm font-semibold",
                        col.isToday && "text-primary"
                      )}
                    >
                      {col.dayNum}
                    </p>
                  </div>

                  {/* Cards area */}
                  <div className="flex-1 overflow-y-auto max-h-[calc(100vh-220px)] space-y-1.5 p-1.5">
                    {dayEvents.length === 0 ? (
                      <p className="py-8 text-center text-xs text-muted-foreground">
                        No loads
                      </p>
                    ) : (
                      dayEvents.map((ev, idx) => (
                        <LoadCard
                          key={`${ev.load_id}-${ev.event_type}-${idx}`}
                          event={ev}
                          onClick={() => router.push(`/loads/${ev.load_id}`)}
                        />
                      ))
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
