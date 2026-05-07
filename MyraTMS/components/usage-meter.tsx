"use client"

import { useTenant } from "@/components/tenant-context"
import { LIMIT_KEYS, type LimitKey } from "@/lib/features"
import { cn } from "@/lib/utils"

/**
 * Tier-aware quota visualizer. Pass a limit key + the current usage and the
 * meter renders a progress bar plus "X / Y" text, color-coded by band:
 *   normal       → muted accent
 *   warn         → amber
 *   limit_reached → orange
 *   over         → red
 *   hard_block   → red, animated
 *
 * Bands match the classifier in lib/features/gate.ts usageBand() so server
 * (gate enforcement) and client (display) agree on what constitutes "warn".
 *
 * Limits returned over the wire as null mean Infinity — the meter renders
 * "unlimited" with no bar.
 */
export function UsageMeter({
  limitKey,
  currentUsage,
  className,
}: {
  limitKey: LimitKey
  currentUsage: number
  className?: string
}) {
  const tenant = useTenant()
  if (!tenant) return null

  const limit = tenant.subscription.limits[limitKey] ?? null
  const description = LIMIT_KEYS[limitKey]

  if (limit === null) {
    return (
      <div className={cn("text-xs text-muted-foreground", className)}>
        <div className="flex items-center justify-between">
          <span>{description}</span>
          <span className="font-mono">unlimited</span>
        </div>
      </div>
    )
  }

  // Mirror lib/features/gate.ts usageBand thresholds. Inlined here so the
  // component doesn't need a non-zero limit-resolving subscription.
  const ratio = limit > 0 ? currentUsage / limit : 0
  const band: "normal" | "warn" | "limit_reached" | "over" | "hard_block" =
    ratio >= 2.0
      ? "hard_block"
      : ratio >= 1.5
        ? "over"
        : ratio >= 1.0
          ? "limit_reached"
          : ratio >= 0.8
            ? "warn"
            : "normal"

  const fillPct = Math.min(100, Math.max(0, ratio * 100))

  const barColor =
    band === "hard_block"
      ? "bg-red-600 animate-pulse"
      : band === "over"
        ? "bg-red-500"
        : band === "limit_reached"
          ? "bg-orange-500"
          : band === "warn"
            ? "bg-amber-500"
            : "bg-accent"

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{description}</span>
        <span className="font-mono tabular-nums">
          {currentUsage} / {limit}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full transition-all duration-300", barColor)}
          style={{ width: `${fillPct}%` }}
          role="progressbar"
          aria-valuenow={currentUsage}
          aria-valuemin={0}
          aria-valuemax={limit}
        />
      </div>
    </div>
  )
}
