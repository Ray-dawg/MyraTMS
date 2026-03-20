'use client'

import { MapPin, Truck, Package, FileText, User, Menu, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { hapticLight } from '@/lib/haptics'

export type Screen = 'map' | 'active' | 'loads' | 'docs' | 'profile'

interface BottomNavProps {
  active: Screen
  onNavigate: (screen: Screen) => void
  hasActiveLoad: boolean
  hidden?: boolean
  onToggleHidden?: () => void
}

const navItems: { id: Screen; label: string; icon: typeof MapPin }[] = [
  { id: 'map', label: 'Map', icon: MapPin },
  { id: 'active', label: 'Active', icon: Truck },
  { id: 'loads', label: 'Loads', icon: Package },
  { id: 'docs', label: 'Docs', icon: FileText },
  { id: 'profile', label: 'Profile', icon: User },
]

export function BottomNav({ active, onNavigate, hasActiveLoad, hidden, onToggleHidden }: BottomNavProps) {
  return (
    <>
      {/* Floating hamburger toggle — visible when nav is hidden */}
      {hidden && (
        <button
          onClick={() => { hapticLight(); onToggleHidden?.() }}
          className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card/90 px-4 py-2.5 shadow-xl backdrop-blur-md transition-all active:scale-90 animate-in fade-in zoom-in-90 duration-300"
          aria-label="Show navigation"
        >
          <Menu className="size-4 text-primary" />
          <span className="text-[11px] font-semibold text-foreground">Menu</span>
        </button>
      )}

      {/* Main nav bar */}
      <nav
        className={cn(
          'safe-bottom fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-card/95 backdrop-blur-md transition-all duration-500',
          hidden && 'translate-y-full opacity-0 pointer-events-none'
        )}
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
                onClick={() => { hapticLight(); onNavigate(item.id) }}
                className={cn(
                  'relative flex flex-1 flex-col items-center gap-0.5 rounded-lg py-2 text-[10px] font-medium transition-all active:scale-90',
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

          {/* Collapse nav button */}
          <button
            onClick={() => { hapticLight(); onToggleHidden?.() }}
            className="flex flex-col items-center gap-0.5 rounded-lg px-2 py-2 text-[10px] font-medium text-muted-foreground transition-all active:scale-90 hover:text-foreground"
            aria-label="Hide navigation"
          >
            <X className="size-4" />
            <span>Hide</span>
          </button>
        </div>
      </nav>
    </>
  )
}
