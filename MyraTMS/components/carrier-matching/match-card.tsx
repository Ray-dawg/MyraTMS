"use client"

import { useState } from "react"
import {
  ChevronDown,
  ChevronUp,
  Phone,
  MapPin,
  TrendingUp,
  Clock,
  Truck,
  UserCheck,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { GradeBadge } from "./grade-badge"
import type { CarrierMatch } from "@/lib/matching"

interface MatchCardProps {
  match: CarrierMatch
  onAssign: (match: CarrierMatch) => void
  assigning?: boolean
}

export function MatchCard({ match, onAssign, assigning }: MatchCardProps) {
  const [expanded, setExpanded] = useState(false)

  const { breakdown: b } = match

  // Build one-line summary
  const summaryParts: string[] = []
  if (b.lane_familiarity.loads_on_lane > 0) {
    summaryParts.push(`${b.lane_familiarity.loads_on_lane} loads on lane`)
  }
  if (match.distance_miles != null && match.distance_miles >= 0) {
    summaryParts.push(`${match.distance_miles}mi from pickup`)
  }
  if (b.reliability.on_time_pct != null) {
    summaryParts.push(`${b.reliability.on_time_pct}% on-time`)
  }
  const summary = summaryParts.join(" \u00B7 ")

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Main row */}
      <div className="flex items-center gap-3 p-3">
        {/* Rank */}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-bold text-foreground">
          #{match.rank}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground truncate">
              {match.carrier_name}
            </span>
            <GradeBadge grade={match.match_grade} score={match.match_score} size="sm" />
          </div>
          {summary && (
            <p className="text-[11px] text-muted-foreground truncate mt-0.5">
              {summary}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {match.contact.phone && (
            <a
              href={`tel:${match.contact.phone}`}
              className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary text-foreground hover:bg-secondary/80 transition-colors"
              title={`Call ${match.contact.name}`}
            >
              <Phone className="h-3.5 w-3.5" />
            </a>
          )}
          <Button
            size="sm"
            className="text-xs h-8 px-3"
            onClick={() => onAssign(match)}
            disabled={assigning}
          >
            Assign
          </Button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* Expanded breakdown */}
      {expanded && (
        <div className="border-t border-border bg-secondary/30 px-3 py-3 space-y-2.5">
          {/* Score bars */}
          <div className="space-y-1.5">
            <ScoreBar
              icon={<MapPin className="h-3 w-3" />}
              label="Lane Familiarity"
              score={b.lane_familiarity.score}
              detail={`${b.lane_familiarity.loads_on_lane} loads on this lane`}
            />
            <ScoreBar
              icon={<Truck className="h-3 w-3" />}
              label="Proximity"
              score={b.proximity.score}
              detail={
                b.proximity.distance_km >= 0
                  ? `${b.proximity.distance_km}km away (${b.proximity.gps_confidence} GPS)`
                  : "No location data"
              }
            />
            <ScoreBar
              icon={<TrendingUp className="h-3 w-3" />}
              label="Rate"
              score={b.rate.score}
              detail={
                b.rate.carrier_avg_rate
                  ? `Avg rate: $${b.rate.carrier_avg_rate.toLocaleString()}`
                  : "No rate history"
              }
            />
            <ScoreBar
              icon={<Clock className="h-3 w-3" />}
              label="Reliability"
              score={b.reliability.score}
              detail={`${b.reliability.total_loads} loads, ${b.reliability.on_time_pct ?? "N/A"}% on-time`}
            />
            <ScoreBar
              icon={<UserCheck className="h-3 w-3" />}
              label="Relationship"
              score={b.relationship.score}
              detail={
                b.relationship.days_since_last != null
                  ? `Last load ${b.relationship.days_since_last}d ago`
                  : "No recent loads"
              }
            />
          </div>

          {/* Driver & contact info */}
          <div className="flex gap-3 text-xs">
            {match.suggested_driver && (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Truck className="h-3 w-3" />
                <span>
                  Driver: {match.suggested_driver.name || "—"}
                  {match.suggested_driver.phone && ` (${match.suggested_driver.phone})`}
                </span>
              </div>
            )}
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Phone className="h-3 w-3" />
              <span>
                {match.contact.name}: {match.contact.phone}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ScoreBar({
  icon,
  label,
  score,
  detail,
}: {
  icon: React.ReactNode
  label: string
  score: number
  detail: string
}) {
  const pct = Math.round(score * 100)
  const barColor =
    pct >= 80
      ? "bg-emerald-500"
      : pct >= 60
        ? "bg-blue-500"
        : pct >= 40
          ? "bg-amber-500"
          : "bg-red-500"

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-0.5">
          <span className="text-[11px] font-medium text-foreground">{label}</span>
          <span className="text-[10px] text-muted-foreground">{pct}%</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-secondary">
          <div
            className={cn("h-full rounded-full transition-all", barColor)}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-[10px] text-muted-foreground mt-0.5">{detail}</p>
      </div>
    </div>
  )
}
