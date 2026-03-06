'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Lock, Eye, EyeOff, AlertTriangle, Loader2, Hash } from 'lucide-react'
import { toast } from 'sonner'
import { driverLogin } from '@/lib/api'
import { T } from '@/lib/driver-theme'

export default function LoginPage() {
  const router = useRouter()
  const [carrierCode, setCarrierCode] = useState('')
  const [pin, setPin] = useState('')
  const [showPin, setShowPin] = useState(false)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  async function handleLogin() {
    if (!carrierCode.trim()) { setErr('Please enter your Carrier Code'); return }
    if (!pin.trim() || pin.length < 4) { setErr('Please enter a valid PIN (at least 4 digits)'); return }

    setErr('')
    setLoading(true)

    const result = await driverLogin(carrierCode.trim(), pin.trim())
    setLoading(false)

    if (result.success) {
      toast.success(`Welcome, ${result.driver?.firstName || 'Driver'}!`)
      router.push('/dashboard')
    } else {
      setErr(result.error || 'Invalid credentials')
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleLogin()
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'linear-gradient(160deg, #060e1a, #091828, #0a1c2e)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '40px 28px',
        fontFamily: "-apple-system, 'SF Pro Display', BlinkMacSystemFont, 'Inter', sans-serif",
      }}
    >
      {/* Branding */}
      <div style={{ marginBottom: 36, textAlign: 'center' }}>
        <img
          src="/myra-logo.png"
          alt="Myra"
          width={72}
          height={72}
          style={{
            borderRadius: 22,
            margin: '0 auto 16px',
            boxShadow: `0 8px 36px ${T.accentGlow}`,
          }}
        />
        <div style={{ color: T.textPrimary, fontSize: 26, fontWeight: 900, letterSpacing: '-0.02em' }}>Myra AI</div>
        <div style={{ color: T.textMuted, fontSize: 13, marginTop: 4 }}>Driver Portal</div>
      </div>

      {/* Form */}
      <div style={{ width: '100%', maxWidth: 360 }} onKeyDown={handleKeyDown}>
        {/* Carrier Code */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: T.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Carrier Code</div>
          <div style={{
            background: 'rgba(255,255,255,0.05)',
            border: `1px solid ${err && !carrierCode ? T.red + '66' : 'rgba(255,255,255,0.1)'}`,
            borderRadius: 14, padding: '13px 16px',
            display: 'flex', gap: 10, alignItems: 'center',
          }}>
            <Hash size={15} color={T.textMuted} />
            <input
              type="text"
              value={carrierCode}
              onChange={e => { setCarrierCode(e.target.value); setErr('') }}
              placeholder="e.g. CR-ABC123 or MC number"
              autoComplete="username"
              autoCapitalize="characters"
              disabled={loading}
              style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                color: T.textPrimary, fontSize: 14, fontFamily: 'inherit',
              }}
            />
          </div>
        </div>

        {/* PIN */}
        <div style={{ marginBottom: err ? 8 : 20 }}>
          <div style={{ color: T.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Driver PIN</div>
          <div style={{
            background: 'rgba(255,255,255,0.05)',
            border: `1px solid ${err && !pin ? T.red + '66' : 'rgba(255,255,255,0.1)'}`,
            borderRadius: 14, padding: '13px 16px',
            display: 'flex', gap: 10, alignItems: 'center',
          }}>
            <Lock size={15} color={T.textMuted} />
            <input
              type={showPin ? 'text' : 'password'}
              value={pin}
              onChange={e => {
                const val = e.target.value.replace(/\D/g, '')
                if (val.length <= 6) { setPin(val); setErr('') }
              }}
              placeholder="••••••"
              inputMode="numeric"
              autoComplete="current-password"
              disabled={loading}
              style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                color: T.textPrimary, fontSize: 14, letterSpacing: '0.1em', fontFamily: 'inherit',
              }}
            />
            <button onClick={() => setShowPin(p => !p)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              {showPin ? <EyeOff size={15} color={T.textMuted} /> : <Eye size={15} color={T.textMuted} />}
            </button>
          </div>
        </div>

        {/* Error */}
        {err && (
          <div style={{ color: T.red, fontSize: 12, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={13} />{err}
          </div>
        )}

        {/* Submit */}
        <button
          onClick={handleLogin}
          disabled={loading}
          style={{
            width: '100%', padding: '17px 0', borderRadius: 18,
            background: T.accentGradient,
            border: 'none', color: T.bg, fontWeight: 800, fontSize: 15,
            cursor: loading ? 'default' : 'pointer',
            boxShadow: `0 8px 32px ${T.accentGlow}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            opacity: loading ? 0.8 : 1,
            fontFamily: 'inherit',
          }}
        >
          {loading
            ? <><Loader2 size={18} className="animate-spin" />Signing in...</>
            : 'Sign In'
          }
        </button>

        <p style={{ textAlign: 'center', marginTop: 16, color: T.textMuted, fontSize: 12 }}>
          Contact your dispatcher if you need help logging in
        </p>
      </div>
    </div>
  )
}
