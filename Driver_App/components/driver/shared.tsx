'use client'

import { type CSSProperties, type ReactNode } from 'react'
import { T } from '@/lib/driver-theme'

/* ── GlassPanel ── */
export function GlassPanel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: T.surface,
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        borderRadius: 20,
        border: `1px solid ${T.borderMuted}`,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/* ── Pill ── */
export function Pill({ children, color }: { children: ReactNode; color?: string }) {
  const c = color || T.accent
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 10px",
        borderRadius: 8,
        background: `${c}1a`,
        border: `1px solid ${c}44`,
        color: c,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  )
}

/* ── Divider ── */
export function Divider() {
  return <div style={{ height: 1, background: "rgba(255,255,255,0.06)", margin: "0 16px" }} />
}

/* ── Toggle ── */
export function Toggle({ on, set }: { on: boolean; set: (fn: (prev: boolean) => boolean) => void }) {
  return (
    <button
      onClick={() => set((p) => !p)}
      style={{
        width: 44,
        height: 24,
        borderRadius: 14,
        background: on ? T.accentDim : "rgba(255,255,255,0.08)",
        border: `1px solid ${on ? T.accent + "44" : "rgba(255,255,255,0.12)"}`,
        position: "relative",
        cursor: "pointer",
        transition: "all 0.2s",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: 18,
          height: 18,
          borderRadius: 10,
          background: on ? T.accent : "rgba(255,255,255,0.3)",
          position: "absolute",
          top: 2,
          left: on ? 23 : 2,
          transition: "all 0.2s",
          boxShadow: on ? `0 0 8px ${T.accentGlow}` : "none",
        }}
      />
    </button>
  )
}

/* ── Page wrapper ── */
export function Page({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: T.bg,
        overflowY: "auto",
        overflowX: "hidden",
        paddingTop: 44,
        paddingBottom: 80,
        scrollbarWidth: "none",
      }}
    >
      {children}
    </div>
  )
}
