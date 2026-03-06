'use client'

import { useEffect } from 'react'
import { T } from '@/lib/driver-theme'
import { GlassPanel } from '@/components/driver/shared'

/* ── Inject shimmer keyframe once ── */
let injected = false
function injectShimmer() {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.textContent = `
    @keyframes driverShimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
  `
  document.head.appendChild(style)
}

/* ── Base Skeleton Bar ── */
export function Skeleton({
  width = '100%',
  height = 14,
  radius = 8,
  style,
}: {
  width?: string | number
  height?: number
  radius?: number
  style?: React.CSSProperties
}) {
  useEffect(injectShimmer, [])

  return (
    <div
      style={{
        width,
        height,
        borderRadius: radius,
        background: `linear-gradient(90deg, rgba(255,255,255,.04) 25%, rgba(255,255,255,.08) 50%, rgba(255,255,255,.04) 75%)`,
        backgroundSize: '200% 100%',
        animation: 'driverShimmer 1.5s ease-in-out infinite',
        ...style,
      }}
    />
  )
}

/* ── Generic Card Skeleton ── */
export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <GlassPanel style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} width={i === 0 ? '60%' : i === rows - 1 ? '40%' : '85%'} height={i === 0 ? 16 : 12} />
      ))}
    </GlassPanel>
  )
}

/* ── Earnings Hero Skeleton ── */
export function SkeletonEarnings() {
  return (
    <GlassPanel style={{ padding: 20, textAlign: 'center' as const }}>
      <Skeleton width={100} height={10} style={{ margin: '0 auto 10px' }} />
      <Skeleton width={140} height={32} radius={12} style={{ margin: '0 auto 16px' }} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        {[1, 2, 3].map(i => (
          <Skeleton key={i} width={80} height={48} radius={12} />
        ))}
      </div>
      {/* Chart placeholder */}
      <div style={{ marginTop: 16, display: 'flex', alignItems: 'flex-end', gap: 6, justifyContent: 'center', height: 80 }}>
        {[40, 65, 50, 80, 70, 35, 10].map((h, i) => (
          <Skeleton key={i} width={28} height={h} radius={6} />
        ))}
      </div>
    </GlassPanel>
  )
}

/* ── Document Row Skeleton ── */
export function SkeletonDocRow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0' }}>
      <Skeleton width={40} height={40} radius={12} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Skeleton width="70%" height={13} />
        <Skeleton width="45%" height={10} />
      </div>
      <Skeleton width={50} height={10} />
    </div>
  )
}
