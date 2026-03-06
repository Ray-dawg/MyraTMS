"use client"

import { Calendar, ArrowRight } from "lucide-react"

interface ShipmentDetailsProps {
  origin: { city: string; state: string; address: string; date: string; time: string }
  destination: { city: string; state: string; address: string; date: string; time: string }
  commodity: string
  weight: string
  pieces: number
  loadNumber: string
  poNumber: string
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-border/60 last:border-0">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={`text-xs font-medium text-foreground ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  )
}

export function ShipmentDetails({ origin, destination, commodity, weight, pieces, loadNumber, poNumber }: ShipmentDetailsProps) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 font-sans">
      {/* Route Card */}
      <div className="lg:col-span-2 rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border/60 px-5 py-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Route
          </h3>
        </div>
        <div className="p-5">
          <div className="flex flex-col gap-0 sm:flex-row sm:items-stretch">
            {/* Origin */}
            <div className="flex-1 rounded-lg bg-secondary/60 p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-2.5 w-2.5 rounded-full bg-foreground ring-4 ring-foreground/10" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
                  Origin
                </span>
              </div>
              <p className="text-lg font-semibold text-foreground leading-tight tracking-tight">
                {origin.city}, {origin.state}
              </p>
              <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">{origin.address}</p>
              <div className="mt-3 flex items-center gap-1.5 rounded-md bg-background/50 px-2.5 py-1.5 w-fit">
                <Calendar className="h-3 w-3 text-muted-foreground" />
                <span className="text-[11px] font-medium text-muted-foreground">
                  {origin.date} <span className="text-foreground">{origin.time}</span>
                </span>
              </div>
            </div>

            {/* Arrow */}
            <div className="flex items-center justify-center px-4 py-3 sm:py-0">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary">
                <ArrowRight className="h-3.5 w-3.5 text-primary rotate-90 sm:rotate-0" />
              </div>
            </div>

            {/* Destination */}
            <div className="flex-1 rounded-lg bg-secondary/60 p-4 ring-1 ring-primary/10">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-2.5 w-2.5 rounded-full bg-primary ring-4 ring-primary/10" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
                  Destination
                </span>
              </div>
              <p className="text-lg font-semibold text-foreground leading-tight tracking-tight">
                {destination.city}, {destination.state}
              </p>
              <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">{destination.address}</p>
              <div className="mt-3 flex items-center gap-1.5 rounded-md bg-background/50 px-2.5 py-1.5 w-fit">
                <Calendar className="h-3 w-3 text-muted-foreground" />
                <span className="text-[11px] font-medium text-muted-foreground">
                  {destination.date} <span className="text-foreground">{destination.time}</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Load Info Card */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border/60 px-5 py-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Load Info
          </h3>
        </div>
        <div className="px-5 py-2">
          <InfoRow label="Load #" value={loadNumber} mono />
          <InfoRow label="PO / Ref" value={poNumber} mono />
          <InfoRow label="Commodity" value={commodity} />
          <InfoRow label="Weight" value={weight} />
          <InfoRow label="Pieces" value={`${pieces} pallets`} />
        </div>
      </div>
    </div>
  )
}
