'use client'

import { useState } from 'react'
import { Check, Loader2, Circle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { driverFetch } from '@/lib/api'

const STATUS_STEPS = [
  { key: 'assigned', label: 'Assigned' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'at_pickup', label: 'At Pickup' },
  { key: 'in_transit', label: 'In Transit' },
  { key: 'at_delivery', label: 'At Delivery' },
  { key: 'delivered', label: 'Delivered' },
] as const

type StatusKey = typeof STATUS_STEPS[number]['key']

interface StatusFlowProps {
  loadId: string
  currentStatus: string
  onStatusChange: (newStatus: string) => void
  onDeliveryReached?: () => void
}

export function StatusFlow({ loadId, currentStatus, onStatusChange, onDeliveryReached }: StatusFlowProps) {
  const [updating, setUpdating] = useState(false)

  const currentIndex = STATUS_STEPS.findIndex((s) => s.key === currentStatus)
  const nextStep = currentIndex >= 0 && currentIndex < STATUS_STEPS.length - 1
    ? STATUS_STEPS[currentIndex + 1]
    : null

  async function advanceStatus() {
    if (!nextStep || updating) return

    setUpdating(true)
    try {
      // Update load status
      const res = await driverFetch(`/api/loads/${loadId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStep.key }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to update status')
      }

      // Post load event for tracking timeline
      await driverFetch(`/api/loads/${loadId}/events`, {
        method: 'POST',
        body: JSON.stringify({
          event_type: 'status_change',
          status: nextStep.key,
          note: `Driver updated status to ${nextStep.label}`,
        }),
      }).catch(() => {
        // Non-critical, don't block status change
      })

      onStatusChange(nextStep.key)
      toast.success(`Status updated to ${nextStep.label}`)

      // Trigger POD capture when reaching at_delivery
      if (nextStep.key === 'at_delivery' && onDeliveryReached) {
        onDeliveryReached()
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update status')
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Visual stepper */}
      <div className="flex items-start gap-0">
        {STATUS_STEPS.map((step, index) => {
          const isPast = index < currentIndex
          const isCurrent = index === currentIndex
          const isFuture = index > currentIndex

          return (
            <div key={step.key} className="flex flex-1 flex-col items-center gap-1.5">
              {/* Step indicator */}
              <div className="flex w-full items-center">
                {index > 0 && (
                  <div
                    className={`h-0.5 flex-1 ${
                      isPast || isCurrent ? 'bg-primary' : 'bg-border'
                    }`}
                  />
                )}
                <div
                  className={`flex size-7 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                    isPast
                      ? 'border-primary bg-primary text-primary-foreground'
                      : isCurrent
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background text-muted-foreground'
                  }`}
                >
                  {isPast ? (
                    <Check className="size-3.5" />
                  ) : isCurrent ? (
                    <Circle className="size-2.5 fill-primary" />
                  ) : (
                    <Circle className="size-2.5" />
                  )}
                </div>
                {index < STATUS_STEPS.length - 1 && (
                  <div
                    className={`h-0.5 flex-1 ${
                      isPast ? 'bg-primary' : 'bg-border'
                    }`}
                  />
                )}
              </div>
              {/* Label */}
              <span
                className={`text-[10px] text-center leading-tight ${
                  isCurrent
                    ? 'font-semibold text-primary'
                    : isPast
                    ? 'text-muted-foreground'
                    : 'text-muted-foreground/50'
                }`}
              >
                {step.label}
              </span>
            </div>
          )
        })}
      </div>

      {/* Action button */}
      {nextStep && (
        <Button
          size="lg"
          className="w-full text-base"
          onClick={advanceStatus}
          disabled={updating}
        >
          {updating ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Updating...
            </>
          ) : (
            nextStep.key === 'delivered' ? `Mark as ${nextStep.label}` : `Advance to ${nextStep.label}`
          )}
        </Button>
      )}

      {currentStatus === 'delivered' && (
        <div className="rounded-lg bg-success/10 border border-success/20 p-3 text-center">
          <p className="text-sm font-medium text-success">Load Delivered</p>
          <p className="text-xs text-muted-foreground mt-1">This load has been completed</p>
        </div>
      )}
    </div>
  )
}
