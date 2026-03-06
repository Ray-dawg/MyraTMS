'use client'

import { MapPin, Truck, Package, FileText, User } from 'lucide-react'
import { cn } from '@/lib/utils'

export type Screen = 'map' | 'active' | 'loads' | 'docs' | 'profile'

interface BottomNavProps {
  active: Screen
  onNavigate: (screen: Screen) => void
  hasActiveLoad: boolean
}

const navItems: { id: Screen; label: string; icon: typeof MapPin }[] = [
  { id: 'map', label: 'Map', icon: MapPin },
  { id: 'active', label: 'Active', icon: Truck },
  { id: 'loads', label: 'Loads', icon: Package },
  { id: 'docs', label: 'Docs', icon: FileText },
  { id: 'profile', label: 'Profile', icon: User },
]

export function BottomNav({ active, onNavigate, hasActiveLoad }: BottomNavProps) {
  return (
    <nav
      className="safe-bottom fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-card/95 backdrop-blur-md"
      role="navigation"
      aria-label="Main navigation"
    >
      <div className="flex items-center justify-around px-1 py-1">
        {navItems.map((item) => {
          const isActive = active === item.id
          const Icon = item.icon
          const showDot = item.id === 'active' && hasActiveLoad && active !== 'active'

          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={cn(
                'relative flex flex-1 flex-col items-center gap-0.5 rounded-lg py-2 text-[10px] font-medium transition-colors',
                isActive
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              aria-current={isActive ? 'page' : undefined}
              aria-label={item.label}
            >
              <Icon className="size-5" strokeWidth={isActive ? 2.5 : 2} />
              <span>{item.label}</span>
              {showDot && (
                <span className="absolute top-1.5 right-1/4 size-2 rounded-full bg-primary" />
              )}
            </button>
          )
        })}
      </div>
    </nav>
  )
}
