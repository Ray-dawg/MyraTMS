'use client'

import { useState } from 'react'
import {
  MapPin,
  Clock,
  Truck,
  DollarSign,
  ChevronRight,
  PackageSearch,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import type { Load } from '@/lib/mock-data'
import { statusLabels, statusColors } from '@/lib/mock-data'

interface LoadsListScreenProps {
  loads: Load[]
  onSelectLoad: (load: Load) => void
}

type FilterTab = 'all' | 'active' | 'upcoming' | 'completed'

export function LoadsListScreen({ loads, onSelectLoad }: LoadsListScreenProps) {
  const [filter, setFilter] = useState<FilterTab>('all')

  const filteredLoads = loads.filter((load) => {
    switch (filter) {
      case 'active':
        return !['assigned', 'delivered', 'completed'].includes(load.status)
      case 'upcoming':
        return load.status === 'assigned'
      case 'completed':
        return ['delivered', 'completed'].includes(load.status)
      default:
        return true
    }
  })

  const filters: { id: FilterTab; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: loads.length },
    {
      id: 'active',
      label: 'Active',
      count: loads.filter(
        (l) => !['assigned', 'delivered', 'completed'].includes(l.status)
      ).length,
    },
    {
      id: 'upcoming',
      label: 'Upcoming',
      count: loads.filter((l) => l.status === 'assigned').length,
    },
    {
      id: 'completed',
      label: 'History',
      count: loads.filter((l) =>
        ['delivered', 'completed'].includes(l.status)
      ).length,
    },
  ]

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    })
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="safe-top border-b border-border bg-card px-4 pb-3 pt-3">
        <h1 className="text-lg font-bold text-foreground">My Loads</h1>
        <p className="text-xs text-muted-foreground">
          {loads.length} total loads
        </p>

        {/* Filter tabs */}
        <div className="mt-3 flex gap-2">
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                filter === f.id
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
              )}
            >
              {f.label}
              <span
                className={cn(
                  'flex size-4 items-center justify-center rounded-full text-[10px] font-bold',
                  filter === f.id
                    ? 'bg-primary-foreground/20 text-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                {f.count}
              </span>
            </button>
          ))}
        </div>
      </header>

      {/* List */}
      <div className="no-scrollbar flex-1 overflow-y-auto pb-20">
        {filteredLoads.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <PackageSearch className="mb-3 size-12 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No loads found</p>
            <p className="mt-1 text-xs text-muted-foreground">
              No loads match the selected filter
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filteredLoads.map((load) => (
              <button
                key={load.id}
                onClick={() => onSelectLoad(load)}
                className="flex w-full items-start gap-3 px-4 py-4 text-left transition-colors hover:bg-secondary/50 active:bg-secondary/70"
              >
                <div className="flex-1">
                  {/* Load ID & Status */}
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-foreground font-mono">
                      {load.id}
                    </span>
                    <Badge
                      className={cn(
                        'text-[10px] py-0 px-1.5',
                        statusColors[load.status]
                      )}
                    >
                      {statusLabels[load.status]}
                    </Badge>
                  </div>

                  {/* Route */}
                  <div className="mt-2 flex items-center gap-1.5">
                    <div className="flex items-center gap-1">
                      <div className="size-1.5 rounded-full bg-accent" />
                      <span className="text-xs text-foreground">
                        {load.pickup.city}, {load.pickup.state}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">{'-->'}</span>
                    <div className="flex items-center gap-1">
                      <div className="size-1.5 rounded-full bg-primary" />
                      <span className="text-xs text-foreground">
                        {load.delivery.city}, {load.delivery.state}
                      </span>
                    </div>
                  </div>

                  {/* Details row */}
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Truck className="size-3" />
                      <span className="text-[11px]">{load.miles} mi</span>
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <DollarSign className="size-3" />
                      <span className="text-[11px] text-primary font-medium">
                        ${load.rate.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Clock className="size-3" />
                      <span className="text-[11px]">
                        {formatDate(load.pickup.scheduledTime)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <MapPin className="size-3" />
                      <span className="text-[11px]">{load.equipment}</span>
                    </div>
                  </div>
                </div>

                <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
