'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { driverLogin, isAuthenticated } from '@/lib/driver-fetch'
import { Loader2, Truck } from 'lucide-react'

export default function LoginPage() {
  const router = useRouter()
  const [carrierCode, setCarrierCode] = useState('')
  const [pin, setPin] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    if (isAuthenticated()) {
      router.replace('/')
    } else {
      setChecking(false)
    }
  }, [router])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!carrierCode.trim() || !pin.trim()) {
      setError('Please enter both carrier code and PIN')
      return
    }
    setLoading(true)
    setError('')
    const result = await driverLogin(carrierCode.trim(), pin.trim())
    setLoading(false)
    if (result.success) {
      router.replace('/')
    } else {
      setError(result.error || 'Login failed')
    }
  }

  if (checking) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background">
        <Loader2 className="size-8 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-6">
      {/* Logo area */}
      <div className="mb-10 flex flex-col items-center">
        <div className="mb-4 flex size-20 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
          <Truck className="size-10 text-primary" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">Myra Driver</h1>
        <p className="mt-1 text-sm text-muted-foreground">Sign in to your account</p>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <div>
          <label htmlFor="carrier-code" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Carrier Code
          </label>
          <input
            id="carrier-code"
            type="text"
            value={carrierCode}
            onChange={(e) => setCarrierCode(e.target.value)}
            placeholder="e.g. MC-884721"
            className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            autoComplete="username"
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="pin" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            PIN
          </label>
          <input
            id="pin"
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            placeholder="6-digit PIN"
            className="w-full rounded-xl border border-border bg-card px-4 py-3 text-center font-mono text-lg tracking-[0.3em] text-foreground placeholder:text-muted-foreground/50 placeholder:tracking-normal placeholder:text-sm placeholder:font-sans focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            autoComplete="current-password"
          />
        </div>

        {error && (
          <div className="rounded-lg bg-destructive/10 px-3 py-2 text-center text-xs text-destructive">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3.5 text-sm font-bold text-primary-foreground shadow-lg transition-all hover:bg-primary/90 active:scale-[0.98] disabled:opacity-60"
        >
          {loading ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Signing in...
            </>
          ) : (
            'Sign In'
          )}
        </button>
      </form>

      {/* Footer */}
      <p className="mt-10 text-[10px] text-muted-foreground/50">
        Myra TMS &middot; Driver Portal
      </p>
    </div>
  )
}
