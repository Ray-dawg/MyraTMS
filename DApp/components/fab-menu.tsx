'use client'

import { useState, useCallback } from 'react'
import {
  Phone,
  Navigation,
  Camera,
  AlertCircle,
  X,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { hapticLight, hapticMedium } from '@/lib/haptics'
import type { Load } from '@/lib/mock-data'

interface FABMenuProps {
  activeLoad: Load | undefined
  onCapturePhoto?: () => void
  className?: string
}

const fabActions = [
  {
    id: 'navigate',
    label: 'Navigate',
    icon: Navigation,
    color: 'bg-accent text-accent-foreground',
    angle: 180,
  },
  {
    id: 'call',
    label: 'Call Broker',
    icon: Phone,
    color: 'bg-success text-success-foreground',
    angle: 225,
  },
  {
    id: 'camera',
    label: 'POD Photo',
    icon: Camera,
    color: 'bg-primary text-primary-foreground',
    angle: 270,
  },
  {
    id: 'issue',
    label: 'Report Issue',
    icon: AlertCircle,
    color: 'bg-destructive text-destructive-foreground',
    angle: 315,
  },
] as const

export function FABMenu({ activeLoad, onCapturePhoto, className }: FABMenuProps) {
  const [open, setOpen] = useState(false)

  const toggle = useCallback(() => {
    hapticLight()
    setOpen((prev) => !prev)
  }, [])

  const handleAction = useCallback(
    (id: string) => {
      hapticMedium()
      setOpen(false)

      if (!activeLoad) return

      switch (id) {
        case 'navigate': {
          const isPickupPhase = ['assigned', 'en_route_pickup'].includes(activeLoad.status)
          const dest = isPickupPhase ? activeLoad.pickup : activeLoad.delivery
          window.open(
            `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}`,
            '_blank'
          )
          break
        }
        case 'call':
          window.location.href = `tel:${activeLoad.brokerPhone}`
          break
        case 'camera':
          onCapturePhoto?.()
          break
        case 'issue':
          // Future: open issue report modal
          break
      }
    },
    [activeLoad, onCapturePhoto]
  )

  if (!activeLoad) return null

  return (
    <div className={cn('fixed bottom-24 right-4 z-40', className)}>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-background/40 backdrop-blur-[2px] animate-in fade-in duration-200"
          onClick={() => { hapticLight(); setOpen(false) }}
        />
      )}

      {/* Action buttons */}
      <div className="relative z-40">
        {fabActions.map((action, i) => {
          const Icon = action.icon
          // Fan out upward in an arc
          const radius = 76
          const startAngle = 200 // degrees
          const spread = 55
          const angle = startAngle + i * spread
          const rad = (angle * Math.PI) / 180
          const x = Math.cos(rad) * radius
          const y = Math.sin(rad) * radius

          return (
            <button
              key={action.id}
              onClick={() => handleAction(action.id)}
              className={cn(
                'absolute flex items-center justify-center rounded-full shadow-lg transition-all duration-300',
                'size-11',
                action.color,
                open
                  ? 'scale-100 opacity-100'
                  : 'pointer-events-none scale-0 opacity-0'
              )}
              style={{
                transform: open
                  ? `translate(${x}px, ${y}px) scale(1)`
                  : 'translate(0, 0) scale(0)',
                transitionDelay: open ? `${i * 40}ms` : '0ms',
                bottom: '0px',
                right: '0px',
              }}
              aria-label={action.label}
            >
              <Icon className="size-5" />
            </button>
          )
        })}

        {/* Labels (shown when open) */}
        {open &&
          fabActions.map((action, i) => {
            const radius = 76
            const startAngle = 200
            const spread = 55
            const angle = startAngle + i * spread
            const rad = (angle * Math.PI) / 180
            const x = Math.cos(rad) * radius
            const y = Math.sin(rad) * radius

            return (
              <span
                key={`label-${action.id}`}
                className="pointer-events-none absolute text-[10px] font-semibold text-foreground whitespace-nowrap transition-all duration-300"
                style={{
                  transform: `translate(${x - 52}px, ${y + 14}px)`,
                  opacity: open ? 1 : 0,
                  transitionDelay: `${i * 40 + 100}ms`,
                  bottom: '0px',
                  right: '0px',
                }}
              >
                {action.label}
              </span>
            )
          })}
      </div>

      {/* Main FAB button */}
      <button
        onClick={toggle}
        className={cn(
          'relative z-50 flex size-14 items-center justify-center rounded-full shadow-xl transition-all duration-300 active:scale-90',
          open
            ? 'bg-card text-foreground rotate-0'
            : 'bg-primary text-primary-foreground'
        )}
        aria-label={open ? 'Close quick actions' : 'Quick actions'}
      >
        <div className={cn('transition-transform duration-300', open && 'rotate-180')}>
          {open ? <X className="size-6" /> : <Zap className="size-6" />}
        </div>
        {/* Pulse ring when closed */}
        {!open && (
          <span className="absolute inset-0 animate-ping rounded-full bg-primary/20" style={{ animationDuration: '3s' }} />
        )}
      </button>
    </div>
  )
}
