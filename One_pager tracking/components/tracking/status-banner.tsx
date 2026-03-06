"use client"

import { cn } from "@/lib/utils"
import { CheckCircle2, Clock, MapPin, Truck } from "lucide-react"

type LoadStatus = "booked" | "picked_up" | "in_transit" | "break_point" | "docking" | "delivered"

interface StatusBannerProps {
  status: LoadStatus
  eta: string
  currentCity: string
  miles: number
}

const steps: { key: LoadStatus; label: string }[] = [
  { key: "booked", label: "Booked" },
  { key: "picked_up", label: "Picked Up" },
  { key: "in_transit", label: "In Transit" },
  { key: "break_point", label: "Break-point" },
  { key: "docking", label: "Docking" },
  { key: "delivered", label: "Delivered" },
]

const statusOrder: LoadStatus[] = ["booked", "picked_up", "in_transit", "break_point", "docking", "delivered"]

function getIndex(s: LoadStatus) {
  return statusOrder.indexOf(s)
}

const statusLabel: Record<LoadStatus, string> = {
  booked: "Booked",
  picked_up: "Picked Up",
  in_transit: "In Transit",
  break_point: "Break-point",
  docking: "Docking",
  delivered: "Delivered",
}

export function StatusBanner({ status, eta, currentCity, miles }: StatusBannerProps) {
  const currentIdx = getIndex(status)
  const isDelivered = status === "delivered"

  return (
    <section className="w-full border-b border-border bg-card font-sans">
      <div className="mx-auto max-w-6xl px-4 py-5 lg:px-6">
        {/* Top row: status badge + ETA */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold",
                isDelivered
                  ? "bg-[var(--brand-success)]/12 text-[var(--brand-success)]"
                  : "bg-primary/10 text-primary"
              )}
            >
              {isDelivered ? (
                <CheckCircle2 className="h-3 w-3" />
              ) : (
                <Truck className="h-3 w-3" />
              )}
              {statusLabel[status]}
            </span>
            {!isDelivered && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MapPin className="h-3 w-3" />
                {currentCity}
              </span>
            )}
          </div>

          {!isDelivered ? (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5">
                <Clock className="h-3.5 w-3.5 text-primary" />
                <span className="text-[11px] text-muted-foreground">ETA</span>
                <span className="text-xs font-semibold text-foreground">{eta}</span>
              </div>
              <span className="text-xs text-muted-foreground">
                {miles.toLocaleString()} mi remaining
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-[var(--brand-success)]" />
              <span className="text-sm font-semibold text-[var(--brand-success)]">
                Shipment Delivered
              </span>
            </div>
          )}
        </div>

        {/* Progress stepper */}
        <div className="mt-5 flex items-center">
          {steps.map((step, idx) => {
            const done = idx < currentIdx
            const active = idx === currentIdx
            const last = idx === steps.length - 1
            const doneColor = isDelivered ? "text-[var(--brand-success)]" : "text-primary"
            const doneBorder = isDelivered
              ? "border-[var(--brand-success)] bg-[var(--brand-success)]/10"
              : "border-primary bg-primary/8"
            const doneLine = isDelivered ? "bg-[var(--brand-success)]/40" : "bg-primary/40"

            return (
              <div key={step.key} className="flex flex-1 items-center">
                <div className="flex flex-col items-center gap-2">
                  <div
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-full border-[1.5px] transition-all duration-300",
                      done || active
                        ? doneBorder
                        : "border-border bg-secondary"
                    )}
                  >
                    {done ? (
                      <CheckCircle2 className={cn("h-4 w-4", doneColor)} strokeWidth={2} />
                    ) : active ? (
                      <span className="relative flex h-2.5 w-2.5">
                        <span className={cn(
                          "absolute inline-flex h-full w-full rounded-full opacity-75 animate-live-pulse",
                          isDelivered ? "bg-[var(--brand-success)]" : "bg-primary"
                        )} />
                        <span className={cn(
                          "relative inline-flex h-2.5 w-2.5 rounded-full",
                          isDelivered ? "bg-[var(--brand-success)]" : "bg-primary"
                        )} />
                      </span>
                    ) : (
                      <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
                    )}
                  </div>
                  <span
                    className={cn(
                      "text-center text-[10px] font-medium leading-tight tracking-wide hidden sm:block",
                      done || active
                        ? active
                          ? isDelivered ? "text-[var(--brand-success)]" : "text-primary"
                          : "text-muted-foreground"
                        : "text-muted-foreground/40"
                    )}
                  >
                    {step.label}
                  </span>
                </div>
                {!last && (
                  <div className="relative mx-1.5 h-[2px] flex-1 overflow-hidden rounded-full bg-border">
                    <div
                      className={cn(
                        "absolute inset-y-0 left-0 rounded-full transition-all duration-500",
                        idx < currentIdx ? doneLine : "w-0"
                      )}
                      style={{ width: idx < currentIdx ? "100%" : "0%" }}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
