'use client'

import { Satellite, Pause, Play, AlertCircle } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { Button } from '@/components/ui/button'

interface GPSTrackerProps {
  status: 'inactive' | 'active' | 'error' | 'denied'
  speedMph: number
  lastReportedAt: Date | null
  error: string | null
  onToggle: () => void
  enabled: boolean
}

export function GPSTracker({
  status,
  speedMph,
  lastReportedAt,
  error,
  onToggle,
  enabled,
}: GPSTrackerProps) {
  const statusColor = {
    active: 'text-success',
    inactive: 'text-muted-foreground',
    error: 'text-destructive',
    denied: 'text-destructive',
  }

  const statusDot = {
    active: 'bg-success',
    inactive: 'bg-muted-foreground',
    error: 'bg-destructive',
    denied: 'bg-destructive',
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
      {/* Status indicator */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <div className="relative">
          <Satellite className={`size-5 ${statusColor[status]}`} />
          <div
            className={`absolute -top-0.5 -right-0.5 size-2 rounded-full ${statusDot[status]} ${
              status === 'active' ? 'animate-pulse' : ''
            }`}
          />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium capitalize">
              GPS {status === 'active' ? 'Active' : status === 'denied' ? 'Denied' : status === 'error' ? 'Error' : 'Off'}
            </span>
            {status === 'active' && (
              <span className="text-sm text-muted-foreground">
                {speedMph} mph
              </span>
            )}
          </div>

          {status === 'active' && lastReportedAt && (
            <p className="text-xs text-muted-foreground">
              Last sent {formatDistanceToNow(lastReportedAt, { addSuffix: true })}
            </p>
          )}

          {(status === 'error' || status === 'denied') && error && (
            <p className="text-xs text-destructive flex items-center gap-1">
              <AlertCircle className="size-3" />
              {error}
            </p>
          )}
        </div>
      </div>

      {/* Toggle button */}
      <Button
        variant="outline"
        size="icon-sm"
        onClick={onToggle}
        title={enabled ? 'Pause GPS' : 'Start GPS'}
      >
        {enabled ? (
          <Pause className="size-4" />
        ) : (
          <Play className="size-4" />
        )}
      </Button>
    </div>
  )
}
