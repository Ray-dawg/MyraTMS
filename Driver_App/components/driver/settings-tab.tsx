'use client'

import { useState } from 'react'
import { T } from '@/lib/driver-theme'
import { GlassPanel, Pill, Divider, Toggle, Page } from '@/components/driver/shared'
import {
  User, Hash, Phone, Truck, CreditCard, Shield, Award,
  Camera, Edit3, Check, X, Lock, Eye, EyeOff,
  AlertTriangle, Loader2, CheckCircle, LogOut,
} from 'lucide-react'

/* ── field definition ── */
const fields = [
  { key: 'name', label: 'Full Name', icon: User, color: T.accent },
  { key: 'email', label: 'Email Address', icon: Hash, color: T.blue },
  { key: 'phone', label: 'Phone Number', icon: Phone, color: T.green },
  { key: 'truck', label: 'Truck Model', icon: Truck, color: T.amber },
  { key: 'plate', label: 'Licence Plate', icon: CreditCard, color: T.purple },
  { key: 'licence', label: "Driver's Licence", icon: Shield, color: T.blue },
  { key: 'carrier', label: 'Carrier Name', icon: Award, color: T.accent },
] as const

type FieldKey = (typeof fields)[number]['key']

export function SettingsTab({
  driverName,
  carrierName,
  onLogout,
}: {
  driverName: string
  carrierName: string
  onLogout: () => void
}) {
  /* ── profile state ── */
  const [profile, setProfile] = useState<Record<FieldKey, string>>({
    name: driverName,
    email: 'driver@myralogistics.com',
    phone: '+1 (555) 482-9103',
    truck: '2024 Freightliner Cascadia',
    plate: 'TRK-4829',
    licence: 'CDL-A 8291047',
    carrier: carrierName,
  })

  const [editField, setEditField] = useState<FieldKey | null>(null)
  const [editVal, setEditVal] = useState('')
  const [savedField, setSavedField] = useState<FieldKey | null>(null)

  /* ── password state ── */
  const [showPw, setShowPw] = useState(false)
  const [pw, setPw] = useState({ current: '', newPw: '', confirm: '' })
  const [pwState, setPwState] = useState<'idle' | 'saving' | 'done' | 'error'>('idle')

  /* ── preferences state ── */
  const [notifs, setNotifs] = useState({ push: true, weather: true, ai: true, dark: true })

  /* ── logout confirmation ── */
  const [logoutConfirm, setLogoutConfirm] = useState(false)

  /* ── helpers ── */
  function startEdit(key: FieldKey) {
    setEditField(key)
    setEditVal(profile[key])
  }

  function saveEdit(key: FieldKey) {
    setProfile((p) => ({ ...p, [key]: editVal }))
    setEditField(null)
    setEditVal('')
    setSavedField(key)
    setTimeout(() => setSavedField(null), 1500)
  }

  function cancelEdit() {
    setEditField(null)
    setEditVal('')
  }

  function handlePasswordUpdate() {
    if (pw.newPw !== pw.confirm) {
      setPwState('error')
      return
    }
    setPwState('saving')
    setTimeout(() => {
      setPwState('done')
      setPw({ current: '', newPw: '', confirm: '' })
      setTimeout(() => setPwState('idle'), 2000)
    }, 1200)
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
            Account
          </div>
          <div style={{ fontSize: 22, fontWeight: 800, color: T.textPrimary }}>Settings</div>
        </div>

        {/* ── Avatar Section ── */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginBottom: 28,
          }}
        >
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <div
              style={{
                width: 80,
                height: 80,
                borderRadius: 40,
                background: `linear-gradient(135deg, ${T.accent}40, ${T.blue}40)`,
                border: `2px solid ${T.accent}44`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <User size={38} color={T.accent} strokeWidth={1.6} />
            </div>
            <button
              style={{
                position: 'absolute',
                bottom: -2,
                right: -2,
                width: 26,
                height: 26,
                borderRadius: 9,
                background: T.accentGradient,
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                boxShadow: `0 2px 8px ${T.accentGlow}`,
              }}
            >
              <Camera size={13} color="#fff" strokeWidth={2.2} />
            </button>
          </div>
          <div
            style={{
              fontSize: 17,
              fontWeight: 800,
              color: T.textPrimary,
              marginBottom: 2,
            }}
          >
            {driverName}
          </div>
          <div
            style={{
              fontSize: 12,
              color: T.textMuted,
              marginBottom: 8,
            }}
          >
            {carrierName}
          </div>
          <Pill color={T.accent}>Active Driver</Pill>
        </div>

        {/* ── Profile Information Section ── */}
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: T.textSecondary,
            marginBottom: 8,
            paddingLeft: 4,
          }}
        >
          Profile Information
        </div>
        <GlassPanel style={{ marginBottom: 24 }}>
          {fields.map((f, i) => {
            const Icon = f.icon
            const isEditing = editField === f.key
            return (
              <div key={f.key}>
                <div
                  style={{
                    padding: '13px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  {/* icon box */}
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 9,
                      background: 'rgba(255,255,255,0.05)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Icon size={14} color={f.color} strokeWidth={2} />
                  </div>

                  {/* label + value */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: T.textMuted,
                        marginBottom: 2,
                      }}
                    >
                      {f.label}
                    </div>
                    {isEditing ? (
                      <input
                        value={editVal}
                        onChange={(e) => setEditVal(e.target.value)}
                        autoFocus
                        style={{
                          width: '100%',
                          fontSize: 13,
                          fontWeight: 600,
                          color: T.textPrimary,
                          background: 'rgba(255,255,255,0.06)',
                          border: `1px solid ${T.accent}44`,
                          borderRadius: 8,
                          padding: '4px 8px',
                          outline: 'none',
                          fontFamily: 'inherit',
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEdit(f.key)
                          if (e.key === 'Escape') cancelEdit()
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: T.textPrimary,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {profile[f.key]}
                      </div>
                    )}
                  </div>

                  {/* action buttons */}
                  {isEditing ? (
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                      <button
                        onClick={() => saveEdit(f.key)}
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 8,
                          background: T.greenDim,
                          border: `1px solid ${T.green}44`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                        }}
                      >
                        <Check size={14} color={T.green} strokeWidth={2.4} />
                      </button>
                      <button
                        onClick={cancelEdit}
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 8,
                          background: T.redDim,
                          border: `1px solid ${T.red}44`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                        }}
                      >
                        <X size={14} color={T.red} strokeWidth={2.4} />
                      </button>
                    </div>
                  ) : savedField === f.key ? (
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        background: T.greenDim,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        animation: 'driverFadeIn 0.3s ease',
                      }}
                    >
                      <Check size={14} color={T.green} strokeWidth={2.4} />
                    </div>
                  ) : (
                    <button
                      onClick={() => startEdit(f.key)}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        background: 'transparent',
                        border: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        opacity: 0.4,
                      }}
                    >
                      <Edit3 size={14} color={T.textSecondary} strokeWidth={2} />
                    </button>
                  )}
                </div>
                {i < fields.length - 1 && <Divider />}
              </div>
            )
          })}
        </GlassPanel>

        {/* ── Security Section ── */}
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: T.textSecondary,
            marginBottom: 8,
            paddingLeft: 4,
          }}
        >
          Security
        </div>
        <GlassPanel style={{ padding: '18px 16px', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: 9,
                background: T.purpleDim,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Lock size={14} color={T.purple} strokeWidth={2} />
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.textPrimary }}>
              Change Password
            </div>
          </div>

          {/* Current Password */}
          <div style={{ marginBottom: 10 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: T.textMuted,
                marginBottom: 5,
              }}
            >
              Current Password
            </div>
            <div
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: `1px solid ${T.borderMuted}`,
                borderRadius: 12,
                padding: '11px 14px',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <input
                type={showPw ? 'text' : 'password'}
                value={pw.current}
                onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))}
                placeholder="••••••••"
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  fontSize: 13,
                  fontWeight: 600,
                  color: T.textPrimary,
                  fontFamily: 'inherit',
                }}
              />
              <button
                onClick={() => setShowPw((p) => !p)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  padding: 0,
                }}
              >
                {showPw ? (
                  <EyeOff size={16} color={T.textMuted} strokeWidth={2} />
                ) : (
                  <Eye size={16} color={T.textMuted} strokeWidth={2} />
                )}
              </button>
            </div>
          </div>

          {/* New Password */}
          <div style={{ marginBottom: 10 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: T.textMuted,
                marginBottom: 5,
              }}
            >
              New Password
            </div>
            <div
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: `1px solid ${T.borderMuted}`,
                borderRadius: 12,
                padding: '11px 14px',
              }}
            >
              <input
                type="password"
                value={pw.newPw}
                onChange={(e) => setPw((p) => ({ ...p, newPw: e.target.value }))}
                placeholder="••••••••"
                style={{
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  fontSize: 13,
                  fontWeight: 600,
                  color: T.textPrimary,
                  fontFamily: 'inherit',
                }}
              />
            </div>
          </div>

          {/* Confirm Password */}
          <div style={{ marginBottom: 14 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: T.textMuted,
                marginBottom: 5,
              }}
            >
              Confirm Password
            </div>
            <div
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: `1px solid ${T.borderMuted}`,
                borderRadius: 12,
                padding: '11px 14px',
              }}
            >
              <input
                type="password"
                value={pw.confirm}
                onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))}
                placeholder="••••••••"
                style={{
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  fontSize: 13,
                  fontWeight: 600,
                  color: T.textPrimary,
                  fontFamily: 'inherit',
                }}
              />
            </div>
          </div>

          {/* Error message */}
          {pwState === 'error' && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                marginBottom: 12,
                color: T.red,
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              <AlertTriangle size={14} strokeWidth={2.2} />
              Passwords do not match
            </div>
          )}

          {/* Update Password button */}
          <button
            onClick={handlePasswordUpdate}
            disabled={pwState === 'saving'}
            style={{
              width: '100%',
              padding: '12px 0',
              borderRadius: 14,
              border: 'none',
              background:
                pwState === 'done'
                  ? `linear-gradient(135deg, ${T.green}, #059669)`
                  : `linear-gradient(135deg, ${T.purple}, #7c3aed)`,
              color: '#fff',
              fontSize: 13,
              fontWeight: 800,
              cursor: pwState === 'saving' ? 'wait' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              opacity: pwState === 'saving' ? 0.7 : 1,
              transition: 'all 0.3s',
            }}
          >
            {pwState === 'saving' && (
              <Loader2 size={16} strokeWidth={2.4} style={{ animation: 'spin 1s linear infinite' }} />
            )}
            {pwState === 'done' && <CheckCircle size={16} strokeWidth={2.4} />}
            {pwState === 'saving'
              ? 'Updating...'
              : pwState === 'done'
                ? 'Password Updated'
                : 'Update Password'}
          </button>
        </GlassPanel>

        {/* ── Preferences Section ── */}
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: T.textSecondary,
            marginBottom: 8,
            paddingLeft: 4,
          }}
        >
          Preferences
        </div>
        <GlassPanel style={{ marginBottom: 24 }}>
          {(
            [
              { key: 'push', label: 'Push Notifications', sub: 'Load alerts & updates' },
              { key: 'weather', label: 'Weather Alerts', sub: 'Route weather warnings' },
              { key: 'ai', label: 'AI Route Suggestions', sub: 'Intelligent optimization' },
              { key: 'dark', label: 'Dark Mode', sub: 'App appearance' },
            ] as const
          ).map((pref, i, arr) => (
            <div key={pref.key}>
              <div
                style={{
                  padding: '13px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.textPrimary }}>
                    {pref.label}
                  </div>
                  <div style={{ fontSize: 11, color: T.textMuted, marginTop: 1 }}>{pref.sub}</div>
                </div>
                <Toggle
                  on={notifs[pref.key]}
                  set={(fn) => setNotifs((prev) => ({ ...prev, [pref.key]: fn(prev[pref.key]) }))}
                />
              </div>
              {i < arr.length - 1 && <Divider />}
            </div>
          ))}
        </GlassPanel>

        {/* ── Sign Out Button ── */}
        <button
          onClick={() => setLogoutConfirm(true)}
          style={{
            width: '100%',
            padding: '14px 0',
            borderRadius: 18,
            background: T.redDim,
            border: `1px solid ${T.red}33`,
            color: T.red,
            fontSize: 14,
            fontWeight: 800,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            marginBottom: 16,
          }}
        >
          <LogOut size={16} strokeWidth={2.2} />
          Sign Out
        </button>

        {/* ── App Version ── */}
        <div
          style={{
            fontSize: 10,
            color: T.textMuted,
            textAlign: 'center',
          }}
        >
          Myra AI Driver App v2.4.1 &middot; Build 2026.02.27
        </div>
      </div>

      {/* ── Logout Confirmation Modal ── */}
      {logoutConfirm && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.78)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: 24,
          }}
          onClick={() => setLogoutConfirm(false)}
        >
          <GlassPanel
            style={{
              padding: '28px 24px',
              maxWidth: 320,
              width: '100%',
              textAlign: 'center',
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}
            >
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 16,
                  background: T.redDim,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 16,
                }}
              >
                <LogOut size={22} color={T.red} strokeWidth={2} />
              </div>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 800,
                  color: T.textPrimary,
                  marginBottom: 8,
                }}
              >
                Sign Out?
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: T.textSecondary,
                  lineHeight: 1.5,
                  marginBottom: 24,
                }}
              >
                You will be signed out of your driver account. Any unsaved changes will be lost.
              </div>
              <div style={{ display: 'flex', gap: 10, width: '100%' }}>
                <button
                  onClick={() => setLogoutConfirm(false)}
                  style={{
                    flex: 1,
                    padding: '12px 0',
                    borderRadius: 14,
                    background: 'rgba(255,255,255,0.06)',
                    border: `1px solid ${T.borderMuted}`,
                    color: T.textSecondary,
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setLogoutConfirm(false)
                    onLogout()
                  }}
                  style={{
                    flex: 1,
                    padding: '12px 0',
                    borderRadius: 14,
                    background: `linear-gradient(135deg, ${T.red}, #dc2626)`,
                    border: 'none',
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 800,
                    cursor: 'pointer',
                    boxShadow: `0 4px 16px rgba(248,113,113,0.25)`,
                  }}
                >
                  Sign Out
                </button>
              </div>
            </div>
          </GlassPanel>
        </div>
      )}

      {/* ── keyframe for spinner ── */}
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </Page>
  )
}
