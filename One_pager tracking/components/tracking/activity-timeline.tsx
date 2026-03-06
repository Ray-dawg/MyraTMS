"use client"

import { cn } from "@/lib/utils"
import { CheckCircle2, MapPin, Package, Truck, Navigation, Home } from "lucide-react"

interface TimelineEvent {
  id: string
  status: string
  location: string
  timestamp: string
  note?: string
  completed: boolean
  active?: boolean
}

interface ActivityTimelineProps {
  events: TimelineEvent[]
}

const iconMap: Record<string, React.ElementType> = {
  booked: Package,
  picked_up: Truck,
  in_transit: Navigation,
  out_for_delivery: Navigation,
  delivered: Home,
  checkpoint: MapPin,
}

export function ActivityTimeline({ events }: ActivityTimelineProps) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden font-sans">
      <div className="border-b border-border/60 px-5 py-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Activity Log
        </h3>
      </div>
      <div className="p-5">
        <ol className="relative">
          {events.map((event, idx) => {
            const Icon = iconMap[event.id] ?? MapPin
            const last = idx === events.length - 1

            return (
              <li key={`${event.id}-${idx}`} className="relative flex gap-4 pb-7 last:pb-0">
                {/* Vertical connector */}
                {!last && (
                  <div
                    className={cn(
                      "absolute left-[15px] top-9 w-px -translate-x-1/2",
                      event.completed ? "bg-primary/20" : "bg-border/60"
                    )}
                    style={{ height: "calc(100% - 28px)" }}
                  />
                )}

                {/* Node */}
                <div
                  className={cn(
                    "relative z-10 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full transition-all",
                    event.active
                      ? "bg-primary/12 ring-[3px] ring-primary/15"
                      : event.completed
                        ? "bg-primary/8"
                        : "bg-secondary"
                  )}
                >
                  {event.active ? (
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-live-pulse" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
                    </span>
                  ) : event.completed ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary" strokeWidth={2} />
                  ) : (
                    <Icon className="h-3 w-3 text-muted-foreground/40" strokeWidth={1.5} />
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0 pt-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <p
                      className={cn(
                        "text-sm font-semibold leading-snug tracking-tight",
                        event.active
                          ? "text-primary"
                          : event.completed
                            ? "text-foreground"
                            : "text-muted-foreground/50"
                      )}
                    >
                      {event.status}
                    </p>
                    <time className="text-[11px] text-muted-foreground/70 tabular-nums">
                      {event.timestamp}
                    </time>
                  </div>
                  <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <MapPin className="h-2.5 w-2.5 shrink-0" />
                    {event.location}
                  </p>
                  {event.note && (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/60">
                      {event.note}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
