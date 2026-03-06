'use client'

import {
  ArrowLeft,
  MapPin,
  Clock,
  Phone,
  Truck,
  Package,
  DollarSign,
  FileText,
  AlertTriangle,
  Navigation,
  Copy,
  CheckCircle2,
} from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { StatusStepper } from '@/components/status-stepper'
import { PODCapture } from '@/components/pod-capture'
import type { Load, LoadStatus } from '@/lib/mock-data'
import { statusLabels, statusColors } from '@/lib/mock-data'

interface LoadDetailsScreenProps {
  load: Load | undefined
  onBack: () => void
  onStatusUpdate: (loadId: string, status: LoadStatus) => void
}

const nextStatusMap: Partial<Record<LoadStatus, LoadStatus>> = {
  assigned: 'en_route_pickup',
  en_route_pickup: 'at_pickup',
  at_pickup: 'loaded',
  loaded: 'en_route_delivery',
  en_route_delivery: 'at_delivery',
  at_delivery: 'delivered',
}

const nextStatusLabels: Partial<Record<LoadStatus, string>> = {
  assigned: 'Start Route to Pickup',
  en_route_pickup: 'Arrived at Pickup',
  at_pickup: 'Confirm Loaded',
  loaded: 'Depart for Delivery',
  en_route_delivery: 'Arrived at Delivery',
  at_delivery: 'Confirm Delivered',
}

export function LoadDetailsScreen({ load, onBack, onStatusUpdate }: LoadDetailsScreenProps) {
  const [copied, setCopied] = useState<string | null>(null)

  if (!load) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <Truck className="mb-4 size-16 text-muted-foreground" />
        <h2 className="text-lg font-semibold text-foreground">No Load Selected</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Go back to select a load from the list
        </p>
        <button
          onClick={onBack}
          className="mt-4 rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground"
        >
          Go Back
        </button>
      </div>
    )
  }

  const nextStatus = nextStatusMap[load.status]
  const nextLabel = nextStatusLabels[load.status]

  const formatTime = (iso: string) => {
    return new Date(iso).toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(label)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="safe-top flex items-center gap-3 border-b border-border bg-card px-4 pb-3 pt-3">
        <button
          onClick={onBack}
          className="flex size-9 items-center justify-center rounded-full bg-secondary text-foreground transition-colors hover:bg-secondary/80"
          aria-label="Go back"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-foreground">{load.id}</h1>
            <Badge className={cn('text-[10px]', statusColors[load.status])}>
              {statusLabels[load.status]}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Ref: {load.referenceNumber}
          </p>
        </div>
      </header>

      {/* Scrollable content */}
      <div className="no-scrollbar flex-1 overflow-y-auto pb-28">
        {/* Status stepper */}
        <div className="border-b border-border bg-card px-4 py-4">
          <StatusStepper status={load.status} />
        </div>

        {/* Pickup Section */}
        <section className="border-b border-border px-4 py-4">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-full bg-accent">
              <MapPin className="size-3.5 text-accent-foreground" />
            </div>
            <h2 className="text-sm font-semibold text-foreground">Pickup</h2>
          </div>
          <div className="ml-9 space-y-2">
            <p className="text-sm font-medium text-foreground">{load.pickup.name}</p>
            <button
              onClick={() =>
                copyToClipboard(
                  `${load.pickup.address}, ${load.pickup.city}, ${load.pickup.state} ${load.pickup.zip}`,
                  'pickup-address'
                )
              }
              className="group flex items-start gap-1.5 text-left"
            >
              <span className="text-xs text-muted-foreground leading-relaxed">
                {load.pickup.address}
                <br />
                {load.pickup.city}, {load.pickup.state} {load.pickup.zip}
              </span>
              {copied === 'pickup-address' ? (
                <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-success" />
              ) : (
                <Copy className="mt-0.5 size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              )}
            </button>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="size-3" />
              <span>{formatTime(load.pickup.scheduledTime)}</span>
              {load.pickup.actualTime && (
                <span className="text-success">
                  (Actual: {formatTime(load.pickup.actualTime)})
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <a
                href={`tel:${load.pickup.contactPhone}`}
                className="flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-secondary/80"
              >
                <Phone className="size-3" />
                {load.pickup.contactName}
              </a>
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${load.pickup.lat},${load.pickup.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs text-accent-foreground transition-colors hover:bg-accent/80"
              >
                <Navigation className="size-3" />
                Navigate
              </a>
            </div>
            {load.pickup.notes && (
              <div className="rounded-md bg-secondary/60 px-3 py-2">
                <p className="text-[11px] text-muted-foreground italic">
                  {load.pickup.notes}
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Delivery Section */}
        <section className="border-b border-border px-4 py-4">
          <div className="mb-3 flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-full bg-primary">
              <MapPin className="size-3.5 text-primary-foreground" />
            </div>
            <h2 className="text-sm font-semibold text-foreground">Delivery</h2>
          </div>
          <div className="ml-9 space-y-2">
            <p className="text-sm font-medium text-foreground">{load.delivery.name}</p>
            <button
              onClick={() =>
                copyToClipboard(
                  `${load.delivery.address}, ${load.delivery.city}, ${load.delivery.state} ${load.delivery.zip}`,
                  'delivery-address'
                )
              }
              className="group flex items-start gap-1.5 text-left"
            >
              <span className="text-xs text-muted-foreground leading-relaxed">
                {load.delivery.address}
                <br />
                {load.delivery.city}, {load.delivery.state} {load.delivery.zip}
              </span>
              {copied === 'delivery-address' ? (
                <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-success" />
              ) : (
                <Copy className="mt-0.5 size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              )}
            </button>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="size-3" />
              <span>{formatTime(load.delivery.scheduledTime)}</span>
              {load.delivery.actualTime && (
                <span className="text-success">
                  (Actual: {formatTime(load.delivery.actualTime)})
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <a
                href={`tel:${load.delivery.contactPhone}`}
                className="flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-secondary/80"
              >
                <Phone className="size-3" />
                {load.delivery.contactName}
              </a>
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${load.delivery.lat},${load.delivery.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Navigation className="size-3" />
                Navigate
              </a>
            </div>
            {load.delivery.notes && (
              <div className="rounded-md bg-secondary/60 px-3 py-2">
                <p className="text-[11px] text-muted-foreground italic">
                  {load.delivery.notes}
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Load Info */}
        <section className="border-b border-border px-4 py-4">
          <h2 className="mb-3 text-sm font-semibold text-foreground">Load Information</h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-secondary p-3">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Package className="size-3" />
                <span className="text-[10px] font-medium uppercase tracking-wider">Commodity</span>
              </div>
              <p className="mt-1 text-xs font-medium text-foreground">{load.commodity}</p>
            </div>
            <div className="rounded-lg bg-secondary p-3">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Truck className="size-3" />
                <span className="text-[10px] font-medium uppercase tracking-wider">Equipment</span>
              </div>
              <p className="mt-1 text-xs font-medium text-foreground">{load.equipment}</p>
            </div>
            <div className="rounded-lg bg-secondary p-3">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Package className="size-3" />
                <span className="text-[10px] font-medium uppercase tracking-wider">Weight</span>
              </div>
              <p className="mt-1 text-xs font-medium text-foreground">
                {load.weight.toLocaleString()} lbs
              </p>
            </div>
            <div className="rounded-lg bg-secondary p-3">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <DollarSign className="size-3" />
                <span className="text-[10px] font-medium uppercase tracking-wider">Rate</span>
              </div>
              <p className="mt-1 text-xs font-medium text-primary">
                ${load.rate.toLocaleString()}
              </p>
            </div>
          </div>
        </section>

        {/* Broker Info */}
        <section className="border-b border-border px-4 py-4">
          <h2 className="mb-3 text-sm font-semibold text-foreground">Broker</h2>
          <div className="flex items-center justify-between rounded-lg bg-secondary p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{load.broker}</p>
              <p className="text-xs text-muted-foreground">{load.brokerPhone}</p>
            </div>
            <a
              href={`tel:${load.brokerPhone}`}
              className="flex size-9 items-center justify-center rounded-full bg-card text-foreground transition-colors hover:bg-card/80"
              aria-label={`Call ${load.broker}`}
            >
              <Phone className="size-4" />
            </a>
          </div>
        </section>

        {/* Special Instructions */}
        {load.specialInstructions && (
          <section className="border-b border-border px-4 py-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Special Instructions</h2>
            </div>
            <div className="mt-2 rounded-lg bg-primary/10 p-3">
              <p className="text-xs text-foreground leading-relaxed">
                {load.specialInstructions}
              </p>
            </div>
          </section>
        )}

        {/* Documents & POD */}
        <section className="px-4 py-4">
          <div className="flex items-center gap-2 mb-3">
            <FileText className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Proof of Delivery</h2>
          </div>
          {['at_delivery', 'delivered'].includes(load.status) ? (
            <PODCapture
              loadId={load.id}
              onCaptured={() => {}}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-border p-6 text-center">
              <p className="text-xs text-muted-foreground">
                POD capture available at delivery
              </p>
            </div>
          )}
        </section>
      </div>

      {/* Status update CTA */}
      {nextStatus && nextLabel && (
        <div className="safe-bottom fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-card px-4 pb-4 pt-3">
          <div className="mb-16">
            <button
              onClick={() => onStatusUpdate(load.id, nextStatus)}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3.5 text-sm font-bold text-primary-foreground shadow-lg transition-all hover:bg-primary/90 active:scale-[0.98]"
            >
              <CheckCircle2 className="size-4" />
              {nextLabel}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
