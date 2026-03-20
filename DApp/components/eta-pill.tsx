'use client'

import { Clock, Navigation, MapPin } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ETAPillProps {
  formatted: string
  distanceMiles: number
  geofenceTarget: 'pickup' | 'delivery' | null
  className?: string
}

export function ETAPill({ formatted, distanceMiles, geofenceTarget, className }: ETAPillProps) {
  if (!geofenceTarget || formatted === '--') return null

  const label = geofenceTarget === 'pickup' ? 'to pickup' : 'to delivery'

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-full border border-border bg-card/90 px-3 py-1.5 shadow-lg backdrop-blur-md transition-all animate-in fade-in slide-in-from-top-2 duration-500',
        className
      )}
    >
      <div className="flex size-6 items-center justify-center rounded-full bg-primary/10">
        <Clock className="size-3.5 text-primary" />
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-sm font-bold text-foreground tabular-nums font-mono">
          {formatted}
        </span>
        <span className="text-[10px] text-muted-foreground">{label}</span>
      </div>
      <span className="text-[10px] text-muted-foreground tabular-nums font-mono">
        {distanceMiles} mi
      </span>
    </div>
  )
}

interface GeofencePromptProps {
  target: 'pickup' | 'delivery'
  onConfirm: () => void
  onDismiss: () => void
}

export function GeofencePrompt({ target, onConfirm, onDismiss }: GeofencePromptProps) {
  const title = target === 'pickup' ? 'Arrived at Pickup?' : 'Arrived at Delivery?'
  const description = target === 'pickup'
    ? 'It looks like you\'re at the pickup location.'
    : 'It looks like you\'re at the delivery location.'

  return (
    <div className="mx-4 rounded-xl border border-primary/30 bg-card p-4 shadow-xl animate-in slide-in-from-bottom-4 zoom-in-95 duration-500">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <MapPin className="size-5 text-primary" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-bold text-foreground">{title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={onConfirm}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary py-2 text-xs font-bold text-primary-foreground transition-all active:scale-95"
            >
              <Navigation className="size-3.5" />
              Yes, I'm Here
            </button>
            <button
              onClick={onDismiss}
              className="rounded-lg bg-secondary px-4 py-2 text-xs font-medium text-muted-foreground transition-all active:scale-95"
            >
              Not Yet
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
