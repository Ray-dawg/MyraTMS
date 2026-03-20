'use client'

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { LogOut, User, Phone, Mail, Truck, Shield, Bell, MapPin, ChevronRight, Sun, Moon } from 'lucide-react'
import { hapticLight } from '@/lib/haptics'

interface ProfileScreenProps {
  onLogout: () => void
}

export function ProfileScreen({ onLogout }: ProfileScreenProps) {
  const { driver } = useAuth()
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const [notifications, setNotifications] = useState(true)
  const [gpsTracking, setGpsTracking] = useState(true)
  const [themeMode, setThemeMode] = useState<'auto' | 'dark' | 'light'>('auto')

  // Theme management
  useEffect(() => {
    const stored = localStorage.getItem('driver-theme')
    if (stored === 'dark' || stored === 'light') setThemeMode(stored)
  }, [])

  const cycleTheme = useCallback(() => {
    hapticLight()
    const next = themeMode === 'auto' ? 'light' : themeMode === 'light' ? 'dark' : 'auto'
    setThemeMode(next)
    localStorage.setItem('driver-theme', next)

    const html = document.documentElement
    if (next === 'light') {
      html.classList.add('light')
    } else if (next === 'dark') {
      html.classList.remove('light')
    } else {
      // Auto: check time of day
      const hour = new Date().getHours()
      if (hour >= 6 && hour < 18) {
        html.classList.add('light')
      } else {
        html.classList.remove('light')
      }
    }
  }, [themeMode])

  // Apply auto theme on mount
  useEffect(() => {
    if (themeMode === 'auto') {
      const hour = new Date().getHours()
      if (hour >= 6 && hour < 18) {
        document.documentElement.classList.add('light')
      } else {
        document.documentElement.classList.remove('light')
      }
    } else if (themeMode === 'light') {
      document.documentElement.classList.add('light')
    } else {
      document.documentElement.classList.remove('light')
    }
  }, [themeMode])

  const initials = driver
    ? `${driver.firstName.charAt(0)}${driver.lastName.charAt(0)}`
    : 'DR'

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="safe-top border-b border-border bg-card px-4 pb-4 pt-3">
        <h1 className="text-lg font-bold text-foreground">Profile</h1>
      </header>

      <div className="no-scrollbar flex-1 overflow-y-auto pb-24">
        {/* Profile card */}
        <div className="flex items-center gap-4 border-b border-border bg-card px-4 py-5">
          <div className="flex size-16 items-center justify-center rounded-full bg-primary/15 ring-2 ring-primary/30">
            <span className="text-xl font-bold text-primary">{initials}</span>
          </div>
          <div>
            <h2 className="text-lg font-bold text-foreground">
              {driver ? `${driver.firstName} ${driver.lastName}` : 'Driver'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {driver?.carrierName || 'Unknown Carrier'}
            </p>
          </div>
        </div>

        {/* Info section */}
        <div className="border-b border-border">
          <h3 className="px-4 pt-4 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Information
          </h3>
          <div className="divide-y divide-border/60">
            <InfoRow icon={User} label="Driver ID" value={driver?.id?.substring(0, 8) || '—'} />
            <InfoRow icon={Truck} label="Carrier ID" value={driver?.carrierId || '—'} />
            <InfoRow icon={Shield} label="Carrier" value={driver?.carrierName || '—'} />
          </div>
        </div>

        {/* Settings section */}
        <div className="border-b border-border">
          <h3 className="px-4 pt-4 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Settings
          </h3>
          <div className="divide-y divide-border/60">
            <ToggleRow
              icon={Bell}
              label="Push Notifications"
              value={notifications}
              onChange={setNotifications}
            />
            <ToggleRow
              icon={MapPin}
              label="GPS Tracking"
              value={gpsTracking}
              onChange={setGpsTracking}
            />
            <button
              onClick={cycleTheme}
              className="flex w-full items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/50"
            >
              {themeMode === 'light' ? (
                <Sun className="size-4 text-primary" />
              ) : themeMode === 'dark' ? (
                <Moon className="size-4 text-accent" />
              ) : (
                <Sun className="size-4 text-muted-foreground" />
              )}
              <span className="flex-1 text-left text-xs text-foreground">Appearance</span>
              <span className="rounded-md bg-secondary px-2 py-0.5 text-[10px] font-semibold text-muted-foreground uppercase">
                {themeMode}
              </span>
            </button>
          </div>
        </div>

        {/* App info */}
        <div className="border-b border-border px-4 py-4">
          <p className="text-xs text-muted-foreground">Myra Driver v1.0.0</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground/60">Build 2026.03.01</p>
        </div>

        {/* Sign out */}
        <div className="px-4 py-4">
          <button
            onClick={() => setShowLogoutConfirm(true)}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 py-3 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/20 active:scale-[0.98]"
          >
            <LogOut className="size-4" />
            Sign Out
          </button>
        </div>
      </div>

      {/* Logout confirmation overlay */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-6">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6">
            <h3 className="text-lg font-bold text-foreground">Sign Out?</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              You'll need your carrier code and PIN to sign back in.
            </p>
            <div className="mt-5 flex gap-3">
              <button
                onClick={() => setShowLogoutConfirm(false)}
                className="flex-1 rounded-xl border border-border bg-secondary py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary/80"
              >
                Cancel
              </button>
              <button
                onClick={onLogout}
                className="flex-1 rounded-xl bg-destructive py-2.5 text-sm font-bold text-destructive-foreground transition-colors hover:bg-destructive/90"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function InfoRow({ icon: Icon, label, value }: { icon: typeof User; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Icon className="size-4 text-muted-foreground" />
      <span className="flex-1 text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xs text-foreground">{value}</span>
    </div>
  )
}

function ToggleRow({ icon: Icon, label, value, onChange }: {
  icon: typeof Bell; label: string; value: boolean; onChange: (v: boolean) => void
}) {
  return (
    <button onClick={() => onChange(!value)} className="flex w-full items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/50">
      <Icon className="size-4 text-muted-foreground" />
      <span className="flex-1 text-left text-xs text-foreground">{label}</span>
      <div className={`relative h-6 w-11 rounded-full transition-colors ${value ? 'bg-primary' : 'bg-secondary'}`}>
        <div className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </div>
    </button>
  )
}
