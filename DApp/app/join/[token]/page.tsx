'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { use } from 'react'
import { setStoredToken, setDriverInfo } from '@/lib/driver-fetch'
import { Loader2, Truck, MapPin, ArrowRight, CheckCircle } from 'lucide-react'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'

interface InviteData {
  firstName: string
  lastName: string
  carrierName: string
  loadSummary: {
    reference: string
    originCity: string
    destCity: string
    pickupDate: string
  }
  status: 'pending' | 'accepted'
}

export default function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [invite, setInvite] = useState<InviteData | null>(null)
  const [error, setError] = useState('')

  // Form state
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    async function fetchInvite() {
      try {
        const res = await fetch(`${API_URL}/api/drivers/invite/${token}`)
        if (res.status === 404) {
          setError('Invalid or expired invite link')
          return
        }
        if (!res.ok) {
          setError('Something went wrong. Please try again.')
          return
        }
        const data: InviteData = await res.json()
        setInvite(data)
        setFirstName(data.firstName || '')
        setLastName(data.lastName || '')
      } catch {
        setError('Network error. Please check your connection.')
      } finally {
        setLoading(false)
      }
    }
    fetchInvite()
  }, [token])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')

    if (!firstName.trim() || !lastName.trim()) {
      setFormError('Please enter your first and last name')
      return
    }
    if (pin.length < 4) {
      setFormError('PIN must be 4 digits')
      return
    }
    if (pin !== confirmPin) {
      setFormError('PINs do not match')
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch(`${API_URL}/api/drivers/accept-invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteToken: token, firstName: firstName.trim(), lastName: lastName.trim(), pin }),
      })
      const data = await res.json()

      if (!res.ok) {
        setFormError(data.error || 'Failed to accept invite')
        return
      }

      // Save auth token and driver info
      if (data.authToken) setStoredToken(data.authToken)
      if (data.driver) setDriverInfo(data.driver)

      router.replace('/')
    } catch {
      setFormError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background">
        <Loader2 className="size-8 animate-spin text-primary" />
      </div>
    )
  }

  // Error state (invalid/expired token)
  if (error) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-6 text-center">
        <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-destructive/10">
          <span className="text-2xl">!</span>
        </div>
        <h1 className="text-xl font-bold text-foreground">{error}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Please contact your dispatcher for a new invite link.
        </p>
      </div>
    )
  }

  // Already accepted
  if (invite?.status === 'accepted') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-6 text-center">
        <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-primary/10">
          <CheckCircle className="size-8 text-primary" />
        </div>
        <h1 className="text-xl font-bold text-foreground">Invite Already Used</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This invite has already been accepted. Please sign in with your carrier code and PIN.
        </p>
        <button
          onClick={() => router.push('/login')}
          className="mt-6 rounded-xl bg-primary px-6 py-3 text-sm font-bold text-primary-foreground shadow-lg transition-all hover:bg-primary/90 active:scale-[0.98]"
        >
          Go to Sign In
        </button>
      </div>
    )
  }

  // Onboarding form
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      {/* Header branding */}
      <div className="flex flex-col items-center px-6 pt-12 pb-6">
        <div className="mb-3 flex size-16 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
          <Truck className="size-8 text-primary" />
        </div>
        <h1 className="text-lg font-bold text-foreground">Myra Logistics</h1>
      </div>

      <div className="flex-1 px-6 pb-8">
        {/* Welcome */}
        <h2 className="text-2xl font-bold text-foreground">
          Welcome, {invite?.firstName}!
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Set up your account to start tracking your load.
        </p>

        {/* Load summary card */}
        {invite?.loadSummary && (
          <div className="mt-5 rounded-xl border border-border bg-card p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Assigned Load
            </p>
            <div className="mt-2 flex items-center gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <MapPin className="size-3.5 text-primary shrink-0" />
                  <span>{invite.loadSummary.originCity}</span>
                  <ArrowRight className="size-3 text-muted-foreground" />
                  <span>{invite.loadSummary.destCity}</span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                  {invite.loadSummary.reference && (
                    <span>Ref: {invite.loadSummary.reference}</span>
                  )}
                  {invite.loadSummary.pickupDate && (
                    <span>
                      Pickup: {new Date(invite.loadSummary.pickupDate).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
            </div>
            {invite.carrierName && (
              <p className="mt-2 text-xs text-muted-foreground">
                Carrier: {invite.carrierName}
              </p>
            )}
          </div>
        )}

        {/* Onboarding form */}
        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="first-name" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              First Name
            </label>
            <input
              id="first-name"
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="last-name" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Last Name
            </label>
            <input
              id="last-name"
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <label htmlFor="pin" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Create PIN
            </label>
            <input
              id="pin"
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              placeholder="4-digit PIN"
              className="w-full rounded-xl border border-border bg-card px-4 py-3 text-center font-mono text-lg tracking-[0.3em] text-foreground placeholder:text-muted-foreground/50 placeholder:tracking-normal placeholder:text-sm placeholder:font-sans focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <label htmlFor="confirm-pin" className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Confirm PIN
            </label>
            <input
              id="confirm-pin"
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
              placeholder="Re-enter PIN"
              className="w-full rounded-xl border border-border bg-card px-4 py-3 text-center font-mono text-lg tracking-[0.3em] text-foreground placeholder:text-muted-foreground/50 placeholder:tracking-normal placeholder:text-sm placeholder:font-sans focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {formError && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-center text-xs text-destructive">
              {formError}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3.5 text-sm font-bold text-primary-foreground shadow-lg transition-all hover:bg-primary/90 active:scale-[0.98] disabled:opacity-60"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Setting up...
              </>
            ) : (
              'Get Started'
            )}
          </button>
        </form>
      </div>

      {/* Footer */}
      <div className="py-4 text-center">
        <p className="text-[10px] text-muted-foreground/50">
          Myra TMS &middot; Driver Portal
        </p>
      </div>
    </div>
  )
}
