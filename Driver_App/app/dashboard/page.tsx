'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, Wifi } from 'lucide-react'
import { isAuthenticated, getDriverInfo } from '@/lib/api'
import { T } from '@/lib/driver-theme'
import { BottomNav, type TabId } from '@/components/driver/bottom-nav'
import { HomeTab } from '@/components/driver/home-tab'
import { EarningsTab } from '@/components/driver/earnings-tab'
import { DocsTab } from '@/components/driver/docs-tab'
import { SettingsTab } from '@/components/driver/settings-tab'

export default function DashboardPage() {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<TabId>('home')
  const [displayTab, setDisplayTab] = useState<TabId>('home')
  const [transitioning, setTransitioning] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace('/login')
    } else {
      setReady(true)
    }
  }, [router])

  const handleTabChange = (tab: TabId) => {
    if (tab === activeTab) return
    setTransitioning(true)
    setTimeout(() => {
      setDisplayTab(tab)
      setActiveTab(tab)
      setTransitioning(false)
    }, 150)
  }

  if (!ready) {
    return (
      <div style={{
        position: 'fixed', inset: 0, background: T.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <img
          src="/icons/icon-192.png"
          alt="Myra"
          width={48}
          height={48}
          style={{
            borderRadius: 16,
            animation: 'driverPulse 1.5s ease-in-out infinite',
          }}
        />
      </div>
    )
  }

  const driverInfo = getDriverInfo()
  const driverName = driverInfo ? `${driverInfo.firstName} ${driverInfo.lastName}` : 'Driver'
  const carrierName = driverInfo?.carrierName || 'Carrier'

  const handleLogout = () => {
    localStorage.removeItem('driver-token')
    localStorage.removeItem('driver-info')
    router.replace('/login')
  }

  // Home tab is fullscreen (has its own position:fixed layout)
  const isHomeTab = activeTab === 'home'

  return (
    <div style={{
      position: 'fixed', inset: 0, background: T.bg,
      fontFamily: "-apple-system, 'SF Pro Display', BlinkMacSystemFont, 'Inter', sans-serif",
      color: T.textPrimary,
      WebkitFontSmoothing: 'antialiased',
    }}>
      {/* Status bar overlay */}
      {!isHomeTab && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 60, height: 44,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 22px',
          background: `linear-gradient(180deg, ${T.bg} 80%, transparent)`,
        }}>
          <span style={{ color: T.textPrimary, fontSize: 13, fontWeight: 700 }}>
            {new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bell size={15} color={T.textMuted} />
            <Wifi size={13} color={T.accent} />
          </div>
        </div>
      )}

      {/* Tab content — conditional render to avoid fixed/absolute z-index overlap */}
      <div style={{
        position: 'fixed', inset: 0,
        opacity: transitioning ? 0 : 1,
        transform: transitioning ? 'translateY(6px)' : 'translateY(0)',
        transition: 'opacity 0.15s ease, transform 0.15s ease',
      }}>
        {displayTab === 'home' && <HomeTab />}
        {displayTab === 'earnings' && <EarningsTab />}
        {displayTab === 'docs' && <DocsTab />}
        {displayTab === 'settings' && <SettingsTab driverName={driverName} carrierName={carrierName} onLogout={handleLogout} />}
      </div>

      {/* Bottom navigation */}
      <BottomNav active={activeTab} onChange={handleTabChange} />
    </div>
  )
}
