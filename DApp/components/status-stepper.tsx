'use client'

import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LoadStatus } from '@/lib/mock-data'

const steps: { key: LoadStatus; label: string }[] = [
  { key: 'assigned', label: 'Assigned' },
  { key: 'en_route_pickup', label: 'En Route' },
  { key: 'at_pickup', label: 'At Pickup' },
  { key: 'loaded', label: 'Loaded' },
  { key: 'en_route_delivery', label: 'In Transit' },
  { key: 'at_delivery', label: 'At Drop' },
  { key: 'delivered', label: 'Delivered' },
]

function getStepIndex(status: LoadStatus): number {
  const idx = steps.findIndex((s) => s.key === status)
  return idx === -1 ? steps.length : idx
}

interface StatusStepperProps {
  status: LoadStatus
  className?: string
}

export function StatusStepper({ status, className }: StatusStepperProps) {
  const currentIndex = getStepIndex(status)

  return (
    <div className={cn('flex items-center gap-1', className)} role="list" aria-label="Load status progress">
      {steps.map((step, i) => {
        const isCompleted = i < currentIndex
        const isCurrent = i === currentIndex

        return (
          <div key={step.key} className="flex flex-1 flex-col items-center gap-1" role="listitem">
            <div className="flex w-full items-center">
              {i > 0 && (
                <div
                  className={cn(
                    'h-0.5 flex-1 rounded-full transition-colors',
                    isCompleted ? 'bg-primary' : 'bg-border'
                  )}
                />
              )}
              <div
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-all',
                  isCompleted && 'bg-primary text-primary-foreground',
                  isCurrent && 'bg-primary text-primary-foreground ring-2 ring-primary/30',
                  !isCompleted && !isCurrent && 'bg-border text-muted-foreground'
                )}
              >
                {isCompleted ? <Check className="size-3" /> : i + 1}
              </div>
              {i < steps.length - 1 && (
                <div
                  className={cn(
                    'h-0.5 flex-1 rounded-full transition-colors',
                    isCompleted ? 'bg-primary' : 'bg-border'
                  )}
                />
              )}
            </div>
            <span
              className={cn(
                'text-center text-[9px] leading-tight',
                isCurrent ? 'font-semibold text-primary' : 'text-muted-foreground'
              )}
            >
              {step.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}
