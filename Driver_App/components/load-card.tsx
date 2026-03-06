'use client'

import { useRouter } from 'next/navigation'
import { MapPin, ArrowRight, Calendar, Truck, ChevronRight } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface Load {
  id: string
  origin: string
  destination: string
  status: string
  pickup_date: string | null
  delivery_date: string | null
  equipment: string
  weight: string
  shipper_name: string
  carrier_name: string
  special_instructions?: string
}

function getStatusVariant(status: string): 'default' | 'secondary' | 'success' | 'warning' | 'outline' {
  switch (status?.toLowerCase()) {
    case 'assigned':
      return 'secondary'
    case 'accepted':
      return 'outline'
    case 'at_pickup':
      return 'warning'
    case 'in_transit':
      return 'default'
    case 'at_delivery':
      return 'warning'
    case 'delivered':
      return 'success'
    default:
      return 'secondary'
  }
}

function formatStatus(status: string): string {
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function LoadCard({ load }: { load: Load }) {
  const router = useRouter()

  function formatDate(dateStr: string | null): string {
    if (!dateStr) return 'TBD'
    try {
      return format(parseISO(dateStr), 'MMM d, h:mm a')
    } catch {
      return dateStr
    }
  }

  return (
    <Card
      className="cursor-pointer active:scale-[0.98] transition-transform"
      onClick={() => router.push(`/loads/${load.id}`)}
    >
      <CardContent className="flex flex-col gap-3">
        {/* Header row */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-mono font-semibold text-primary">{load.id}</span>
          <div className="flex items-center gap-2">
            <Badge variant={getStatusVariant(load.status)}>
              {formatStatus(load.status)}
            </Badge>
            <ChevronRight className="size-4 text-muted-foreground" />
          </div>
        </div>

        {/* Route */}
        <div className="flex items-start gap-2">
          <div className="flex flex-col items-center gap-1 pt-0.5">
            <div className="size-2 rounded-full bg-success" />
            <div className="h-6 w-px bg-border" />
            <div className="size-2 rounded-full bg-destructive" />
          </div>
          <div className="flex flex-1 flex-col gap-2 min-w-0">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{load.origin}</p>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Calendar className="size-3" />
                  Pickup: {formatDate(load.pickup_date)}
                </p>
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{load.destination}</p>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Calendar className="size-3" />
                Delivery: {formatDate(load.delivery_date)}
              </p>
            </div>
          </div>
        </div>

        {/* Footer info */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground pt-1 border-t border-border">
          {load.equipment && (
            <span className="flex items-center gap-1">
              <Truck className="size-3" />
              {load.equipment}
            </span>
          )}
          {load.weight && (
            <span>{load.weight}</span>
          )}
          {load.shipper_name && (
            <span className="ml-auto truncate max-w-[120px]">{load.shipper_name}</span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
