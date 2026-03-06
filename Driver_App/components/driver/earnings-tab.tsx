'use client'

import { useState, useEffect } from 'react'
import { ChevronRight, MapPin, Clock, Navigation } from 'lucide-react'
import { T } from '@/lib/driver-theme'
import { GlassPanel, Page } from '@/components/driver/shared'
import { SkeletonEarnings, SkeletonCard } from '@/components/driver/skeleton'

/* ── Mock Data ── */

const WEEKLY = [
  { d: 'Mon', v: 180 },
  { d: 'Tue', v: 420 },
  { d: 'Wed', v: 310 },
  { d: 'Thu', v: 560 },
  { d: 'Fri', v: 480 },
  { d: 'Sat', v: 240 },
  { d: 'Sun', v: 0 },
]

const TRIP_HISTORY = [
  { id: 'T-1001', from: 'Toronto, ON', to: 'Montreal, QC', earned: 680, distance: '541 km', date: 'Today', status: 'completed' },
  { id: 'T-1002', from: 'Montreal, QC', to: 'Ottawa, ON', earned: 340, distance: '199 km', date: 'Today', status: 'completed' },
  { id: 'T-1003', from: 'Ottawa, ON', to: 'Kingston, ON', earned: 220, distance: '196 km', date: 'Yesterday', status: 'completed' },
  { id: 'T-1004', from: 'Kingston, ON', to: 'Toronto, ON', earned: 380, distance: '264 km', date: 'Yesterday', status: 'completed' },
  { id: 'T-1005', from: 'Toronto, ON', to: 'Barrie, ON', earned: 180, distance: '108 km', date: 'Feb 25', status: 'completed' },
  { id: 'T-1006', from: 'Barrie, ON', to: 'Sudbury, ON', earned: 560, distance: '305 km', date: 'Feb 24', status: 'completed' },
  { id: 'T-1007', from: 'Sudbury, ON', to: 'Toronto, ON', earned: 480, distance: '390 km', date: 'Feb 23', status: 'completed' },
]

/* ── Stats ── */

const STATS = [
  { label: 'Avg/Day', value: '$314', color: T.accent },
  { label: 'Best Day', value: '$560', color: T.green },
  { label: 'Active Days', value: '6', color: T.blue },
]

/* ── Component ── */

export function EarningsTab() {
  const [period, setPeriod] = useState<'week' | 'month'>('week')
  const [expandedTrip, setExpandedTrip] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setLoaded(true), 400)
    return () => clearTimeout(t)
  }, [])

  const maxVal = Math.max(...WEEKLY.map((w) => w.v))

  if (!loaded) {
    return (
      <Page>
        <div style={{ padding: '16px 18px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SkeletonEarnings />
          <SkeletonCard rows={4} />
          <SkeletonCard rows={3} />
        </div>
      </Page>
    )
  }

  return (
    <Page>
      <div style={{ padding: '16px 18px 32px' }}>

        {/* ── Header ── */}
        <div style={{ marginBottom: 20 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: T.textMuted,
              marginBottom: 4,
            }}
          >
            Financial Overview
          </div>
          <div
            style={{
              fontSize: 26,
              fontWeight: 800,
              color: T.textPrimary,
              letterSpacing: '-0.02em',
            }}
          >
            Earnings
          </div>
        </div>

        {/* ── Today's Earnings Hero Card ── */}
        <GlassPanel style={{ padding: '20px 22px', marginBottom: 16, border: `1px solid ${T.accent}22` }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: T.textMuted,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 8,
            }}
          >
            Today&apos;s Earnings
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 2, marginBottom: 6 }}>
            <span style={{ fontSize: 28, fontWeight: 800, color: T.accent }}>$</span>
            <span style={{ fontSize: 38, fontWeight: 800, color: T.textPrimary, letterSpacing: '-0.02em' }}>
              1,240
            </span>
          </div>
          <div style={{ fontSize: 11, color: T.textMuted }}>Last updated just now</div>
        </GlassPanel>

        {/* ── Period Toggle ── */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {(['week', 'month'] as const).map((p) => {
            const active = period === p
            return (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                style={{
                  flex: 1,
                  padding: '10px 0',
                  borderRadius: 12,
                  border: active ? `1px solid ${T.accent}44` : '1px solid rgba(255,255,255,.1)',
                  background: active ? T.accentDim : 'rgba(255,255,255,.06)',
                  color: active ? T.accent : T.textMuted,
                  fontWeight: active ? 800 : 500,
                  fontSize: 13,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  letterSpacing: '0.02em',
                }}
              >
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            )
          })}
        </div>

        {/* ── Bar Chart ── */}
        <GlassPanel style={{ padding: '18px 14px 14px', marginBottom: 16 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
              gap: 6,
            }}
          >
            {WEEKLY.map((day) => {
              const barHeight = maxVal > 0 ? (day.v / maxVal) * 100 : 0
              const isMax = day.v === maxVal && day.v > 0
              return (
                <div
                  key={day.d}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    flex: 1,
                    gap: 6,
                  }}
                >
                  {/* Bar */}
                  <div
                    style={{
                      width: 28,
                      height: barHeight,
                      minHeight: day.v > 0 ? 4 : 2,
                      borderRadius: '6px 6px 2px 2px',
                      background: isMax ? T.accentGradient : 'rgba(59, 130, 246, 0.25)',
                      transition: 'height 0.3s ease',
                    }}
                  />
                  {/* Day label */}
                  <div style={{ fontSize: 10, color: T.textMuted, fontWeight: 500 }}>{day.d}</div>
                  {/* Dollar value */}
                  <div style={{ fontSize: 10, color: T.textSecondary, fontWeight: 600 }}>
                    ${day.v}
                  </div>
                </div>
              )
            })}
          </div>
        </GlassPanel>

        {/* ── Stats Grid ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 24 }}>
          {STATS.map((stat) => (
            <div
              key={stat.label}
              style={{
                background: T.surface,
                backdropFilter: 'blur(24px)',
                WebkitBackdropFilter: 'blur(24px)',
                borderRadius: 14,
                border: `1px solid ${T.borderMuted}`,
                padding: '12px 10px',
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  color: T.textMuted,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  marginBottom: 6,
                }}
              >
                {stat.label}
              </div>
              <div style={{ fontSize: 16, fontWeight: 800, color: stat.color }}>
                {stat.value}
              </div>
            </div>
          ))}
        </div>

        {/* ── Trip History ── */}
        <div style={{ marginBottom: 12 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: T.textSecondary,
              marginBottom: 10,
            }}
          >
            Recent Trips
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {TRIP_HISTORY.map((trip) => {
              const isExpanded = expandedTrip === trip.id
              return (
                <GlassPanel key={trip.id} style={{ overflow: 'hidden' }}>
                  {/* Collapsed row */}
                  <button
                    onClick={() => setExpandedTrip(isExpanded ? null : trip.id)}
                    style={{
                      width: '100%',
                      padding: '14px 16px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    {/* Trip ID */}
                    <div
                      style={{
                        fontSize: 10,
                        fontFamily: 'monospace',
                        color: T.textMuted,
                        fontWeight: 600,
                        minWidth: 48,
                      }}
                    >
                      {trip.id}
                    </div>

                    {/* Route */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: T.textPrimary,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {trip.from} <span style={{ color: T.textMuted }}>→</span> {trip.to}
                      </div>
                      <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>{trip.date}</div>
                    </div>

                    {/* Earned */}
                    <div style={{ fontSize: 14, fontWeight: 800, color: T.accent, flexShrink: 0 }}>
                      ${trip.earned}
                    </div>

                    {/* Chevron */}
                    <ChevronRight
                      size={16}
                      color={T.textMuted}
                      style={{
                        flexShrink: 0,
                        transition: 'transform 0.2s',
                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                      }}
                    />
                  </button>

                  {/* Expanded details */}
                  {isExpanded && (
                    <div
                      style={{
                        padding: '0 16px 14px',
                        borderTop: `1px solid ${T.borderMuted}`,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          gap: 16,
                          paddingTop: 12,
                          marginBottom: 12,
                        }}
                      >
                        {/* Distance */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Navigation size={13} color={T.blue} />
                          <div>
                            <div style={{ fontSize: 9, color: T.textMuted, textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.04em' }}>
                              Distance
                            </div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: T.textPrimary }}>{trip.distance}</div>
                          </div>
                        </div>

                        {/* Status */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Clock size={13} color={T.green} />
                          <div>
                            <div style={{ fontSize: 9, color: T.textMuted, textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.04em' }}>
                              Status
                            </div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: T.green, textTransform: 'capitalize' }}>
                              {trip.status}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* View Details button */}
                      <button
                        style={{
                          width: '100%',
                          padding: '10px 0',
                          borderRadius: 10,
                          border: `1px solid ${T.accent}44`,
                          background: T.accentDim,
                          color: T.accent,
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 6,
                          letterSpacing: '0.02em',
                        }}
                      >
                        <MapPin size={13} />
                        View Details
                      </button>
                    </div>
                  )}
                </GlassPanel>
              )
            })}
          </div>
        </div>
      </div>
    </Page>
  )
}
