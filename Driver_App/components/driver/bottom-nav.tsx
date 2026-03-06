'use client'

import { Home, DollarSign, FileText, Settings as SettingsIcon } from 'lucide-react'
import { T } from '@/lib/driver-theme'

const TABS = [
  { id: "home", label: "Home", Icon: Home },
  { id: "earnings", label: "Earnings", Icon: DollarSign },
  { id: "docs", label: "Docs", Icon: FileText },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
] as const

export type TabId = (typeof TABS)[number]["id"]

export function BottomNav({ active, onChange }: { active: TabId; onChange: (tab: TabId) => void }) {
  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        background: "rgba(8, 13, 20, 0.95)",
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        borderTop: `1px solid ${T.borderMuted}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-around",
        paddingTop: 8,
        paddingBottom: "max(8px, env(safe-area-inset-bottom))",
        zIndex: 50,
      }}
    >
      {TABS.map(({ id, label, Icon }) => {
        const isActive = active === id
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 3,
              padding: "4px 16px",
              background: "none",
              border: "none",
              cursor: "pointer",
              transition: "all 0.2s",
            }}
          >
            <div
              style={{
                width: 36,
                height: 28,
                borderRadius: 10,
                background: isActive ? T.accentDim : "transparent",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all 0.2s",
              }}
            >
              <Icon size={18} color={isActive ? T.accent : T.textMuted} />
            </div>
            <span
              style={{
                fontSize: 10,
                fontWeight: isActive ? 700 : 500,
                color: isActive ? T.accent : T.textMuted,
                letterSpacing: "0.02em",
              }}
            >
              {label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
