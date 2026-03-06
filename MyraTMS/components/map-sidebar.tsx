"use client"

import { Search, X, ExternalLink } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import Link from "next/link"

export interface MapFilters {
  statuses: string[]
  equipment: string
  search: string
}

export interface MapSummary {
  total: number
  booked: number
  dispatched: number
  in_transit: number
  delivered: number
  exceptions: number
}

export interface MapLoad {
  id: string
  reference_number: string | null
  status: string
  equipment: string | null
  origin: string
  destination: string
  origin_city: string | null
  dest_city: string | null
  origin_lat: number | null
  origin_lng: number | null
  dest_lat: number | null
  dest_lng: number | null
  current_lat: number | null
  current_lng: number | null
  current_eta: string | null
  shipper_name: string | null
  carrier_name: string | null
  driver_name: string | null
  has_exception: boolean | null
  pickup_date: string | null
  delivery_date: string | null
  last_ping_at: string | null
}

const STATUS_CONFIG = [
  { value: "Booked", label: "Booked", color: "#9E9E9E" },
  { value: "Dispatched", label: "Dispatched", color: "#FF9800" },
  { value: "In Transit", label: "In Transit", color: "#4CAF50" },
  { value: "Delivered", label: "Delivered", color: "#2E7D32" },
  { value: "Invoiced", label: "Invoiced", color: "#2E7D32" },
]

interface MapSidebarProps {
  loads: MapLoad[]
  filters: MapFilters
  onFilterChange: (filters: MapFilters) => void
  selectedLoad: MapLoad | null
  onSelectLoad: (load: MapLoad | null) => void
  summary: MapSummary
  lastUpdated: Date | null
}

export function MapSidebar({
  loads,
  filters,
  onFilterChange,
  selectedLoad,
  onSelectLoad,
  summary,
  lastUpdated,
}: MapSidebarProps) {
  const toggleStatus = (status: string) => {
    const current = filters.statuses
    const next = current.includes(status)
      ? current.filter((s) => s !== status)
      : [...current, status]
    onFilterChange({ ...filters, statuses: next })
  }

  return (
    <div className="flex h-full flex-col bg-sidebar border-r border-border">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground">Load Map</h2>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          {summary.total} active loads
        </p>
      </div>

      {/* Summary badges */}
      <div className="px-4 py-3 border-b border-border">
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          {summary.booked > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "#9E9E9E" }} />
              {summary.booked} Booked
            </div>
          )}
          {summary.dispatched > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "#FF9800" }} />
              {summary.dispatched} Dispatched
            </div>
          )}
          {summary.in_transit > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "#4CAF50" }} />
              {summary.in_transit} In Transit
            </div>
          )}
          {summary.delivered > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: "#2E7D32" }} />
              {summary.delivered} Delivered
            </div>
          )}
          {summary.exceptions > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-destructive">
              <span className="h-2 w-2 rounded-full bg-destructive" />
              {summary.exceptions} Exception{summary.exceptions !== 1 ? "s" : ""}
            </div>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="px-4 py-3 border-b border-border">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search loads, shippers, carriers..."
            value={filters.search}
            onChange={(e) => onFilterChange({ ...filters, search: e.target.value })}
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      {/* Status filters */}
      <div className="px-4 py-3 border-b border-border space-y-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Status Filter
        </p>
        {STATUS_CONFIG.map((s) => {
          const count = loads.filter((l) => l.status === s.value).length
          const checked = filters.statuses.includes(s.value)
          return (
            <label
              key={s.value}
              className="flex items-center gap-2 cursor-pointer group"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleStatus(s.value)}
                className="sr-only"
              />
              <span
                className={cn(
                  "flex h-4 w-4 items-center justify-center rounded border transition-colors",
                  checked
                    ? "border-transparent"
                    : "border-border bg-transparent"
                )}
                style={checked ? { backgroundColor: s.color } : undefined}
              >
                {checked && (
                  <svg className="h-3 w-3 text-white" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className="text-xs text-foreground group-hover:text-foreground/80 flex-1">
                {s.label}
              </span>
              <Badge variant="secondary" className="text-[10px] h-4 min-w-[20px] justify-center px-1">
                {count}
              </Badge>
            </label>
          )
        })}
      </div>

      {/* Equipment filter */}
      <div className="px-4 py-3 border-b border-border">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
          Equipment
        </p>
        <Select
          value={filters.equipment || "all"}
          onValueChange={(v) =>
            onFilterChange({ ...filters, equipment: v === "all" ? "" : v })
          }
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="All Equipment" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Equipment</SelectItem>
            <SelectItem value="Dry Van">Dry Van</SelectItem>
            <SelectItem value="Reefer">Reefer</SelectItem>
            <SelectItem value="Flatbed">Flatbed</SelectItem>
            <SelectItem value="Other">Other</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Spacer */}
      <div className="flex-1 overflow-y-auto" />

      {/* Selected load card */}
      {selectedLoad && (
        <div className="border-t border-border p-4 space-y-2 bg-card/50">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-foreground">
              {selectedLoad.reference_number || selectedLoad.id}
            </p>
            <button
              onClick={() => onSelectLoad(null)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <Badge
            variant="outline"
            className="text-[10px]"
            style={{
              borderColor: selectedLoad.has_exception
                ? "#F44336"
                : STATUS_CONFIG.find((s) => s.value === selectedLoad.status)?.color,
              color: selectedLoad.has_exception
                ? "#F44336"
                : STATUS_CONFIG.find((s) => s.value === selectedLoad.status)?.color,
            }}
          >
            {selectedLoad.has_exception ? "Exception" : selectedLoad.status}
          </Badge>
          <div className="text-[11px] text-muted-foreground space-y-1">
            <p>
              {selectedLoad.origin_city || selectedLoad.origin?.split(",")[0]} →{" "}
              {selectedLoad.dest_city || selectedLoad.destination?.split(",")[0]}
            </p>
            {selectedLoad.shipper_name && (
              <p>Shipper: {selectedLoad.shipper_name}</p>
            )}
            {selectedLoad.carrier_name && (
              <p>Carrier: {selectedLoad.carrier_name}</p>
            )}
            {selectedLoad.driver_name && (
              <p>Driver: {selectedLoad.driver_name}</p>
            )}
            {selectedLoad.current_eta && selectedLoad.status === "In Transit" && (
              <p>ETA: {new Date(selectedLoad.current_eta).toLocaleString()}</p>
            )}
          </div>
          <Link href={`/loads/${selectedLoad.id}`}>
            <Button variant="outline" size="sm" className="w-full h-7 text-xs gap-1.5 mt-1">
              <ExternalLink className="h-3 w-3" />
              View Load
            </Button>
          </Link>
        </div>
      )}

      {/* Last updated */}
      {lastUpdated && (
        <div className="px-4 py-2 border-t border-border">
          <p className="text-[10px] text-muted-foreground">
            Updated {formatTimeAgo(lastUpdated)}
          </p>
        </div>
      )}
    </div>
  )
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 5) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ago`
}
