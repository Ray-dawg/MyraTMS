"use client"

import { useState } from "react"
import Image from "next/image"
import { ThemeToggle } from "@/components/tracking/theme-toggle"
import { CheckCircle2, XCircle, Truck, MapPin, Calendar, DollarSign } from "lucide-react"

interface ConfirmationSnapshot {
  loadId: string
  origin: string
  destination: string
  pickupDate: string | null
  deliveryDate: string | null
  equipmentType: string
  rate: string | number | null
  rateCurrency: string | null
}

interface ConfirmClientProps {
  token: string
  apiUrl: string
  loadId: string
  stage: string
  alreadyResolved: boolean
  snapshot: ConfirmationSnapshot | null
}

type ViewState = "review" | "confirming" | "confirmed" | "declining" | "declined" | "error"

function formatDate(value: string | null): string {
  if (!value) return "TBD"
  try {
    const d = new Date(value)
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })
  } catch {
    return value
  }
}

function formatRate(rate: string | number | null, currency: string | null): string {
  if (rate == null) return "TBD"
  const num = typeof rate === "string" ? Number(rate) : rate
  if (Number.isNaN(num)) return "TBD"
  return `${currency || "CAD"} $${num.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
}

export function ConfirmClient({ token, apiUrl, loadId, alreadyResolved, snapshot }: ConfirmClientProps) {
  const [view, setView] = useState<ViewState>(alreadyResolved ? "confirmed" : "review")
  const [declineReason, setDeclineReason] = useState("")
  const [showDeclineForm, setShowDeclineForm] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleConfirm() {
    setView("confirming")
    setErrorMessage(null)
    try {
      const res = await fetch(`${apiUrl}/api/confirmations/${token}/confirm`, { method: "POST" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setErrorMessage(body.error || "Something went wrong confirming this load.")
        setView("error")
        return
      }
      setView("confirmed")
    } catch {
      setErrorMessage("Network error — please try again.")
      setView("error")
    }
  }

  async function handleDecline() {
    setView("declining")
    setErrorMessage(null)
    try {
      const res = await fetch(`${apiUrl}/api/confirmations/${token}/decline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: declineReason || null }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setErrorMessage(body.error || "Something went wrong declining this load.")
        setView("error")
        return
      }
      setView("declined")
    } catch {
      setErrorMessage("Network error — please try again.")
      setView("error")
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background font-sans">
      <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <Image src="/myra-logo.png" alt="Myra AI" width={32} height={32} className="rounded-lg" />
            <div className="flex items-baseline gap-1">
              <span className="text-base font-semibold tracking-tight text-foreground">Myra</span>
              <span className="text-base font-semibold tracking-tight text-primary">AI</span>
            </div>
            <div className="hidden h-4 w-px bg-border sm:block" />
            <span className="hidden text-xs text-muted-foreground sm:block">Rate Confirmation</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-8 lg:px-6">
        <div className="mb-6 text-center">
          <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">Load Reference</p>
          <p className="font-mono text-lg font-semibold text-foreground">{loadId}</p>
        </div>

        {(view === "review" || view === "confirming" || view === "declining" || view === "error") && (
          <div className="rounded-xl border border-border bg-card p-6 lg:p-8">
            <h1 className="mb-1 text-xl font-semibold text-foreground">Confirm Your Load</h1>
            <p className="mb-6 text-sm text-muted-foreground">
              Please review the terms below and confirm to move forward with carrier dispatch.
            </p>

            {snapshot && (
              <div className="mb-6 space-y-4 rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex items-start gap-3">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">Lane</p>
                    <p className="text-sm font-medium text-foreground">
                      {snapshot.origin} &rarr; {snapshot.destination}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Calendar className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">Pickup</p>
                    <p className="text-sm font-medium text-foreground">{formatDate(snapshot.pickupDate)}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Truck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">Equipment</p>
                    <p className="text-sm font-medium text-foreground">{snapshot.equipmentType}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <DollarSign className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div>
                    <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">Agreed Rate</p>
                    <p className="text-lg font-semibold text-foreground">{formatRate(snapshot.rate, snapshot.rateCurrency)}</p>
                  </div>
                </div>
              </div>
            )}

            {view === "error" && errorMessage && (
              <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {errorMessage}
              </div>
            )}

            {!showDeclineForm ? (
              <div className="flex flex-col gap-3 sm:flex-row">
                <button
                  onClick={handleConfirm}
                  disabled={view === "confirming" || view === "declining"}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {view === "confirming" ? "Confirming…" : "Confirm This Load"}
                </button>
                <button
                  onClick={() => setShowDeclineForm(true)}
                  disabled={view === "confirming" || view === "declining"}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-transparent px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                >
                  <XCircle className="h-4 w-4" />
                  Decline
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block text-xs font-medium text-muted-foreground">
                  Let us know why (optional)
                </label>
                <textarea
                  value={declineReason}
                  onChange={(e) => setDeclineReason(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                  placeholder="e.g. rate needs to be renegotiated, pickup date doesn't work…"
                />
                <div className="flex flex-col gap-3 sm:flex-row">
                  <button
                    onClick={handleDecline}
                    disabled={view === "declining"}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-destructive px-4 py-3 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50"
                  >
                    {view === "declining" ? "Submitting…" : "Submit Decline"}
                  </button>
                  <button
                    onClick={() => setShowDeclineForm(false)}
                    disabled={view === "declining"}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-transparent px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    Back
                  </button>
                </div>
              </div>
            )}

            <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
              After confirming, please also reply to the confirmation email with a signed copy of the
              attached rate confirmation for our records.
            </p>
          </div>
        )}

        {view === "confirmed" && (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
              <CheckCircle2 className="h-7 w-7 text-primary" />
            </div>
            <h1 className="mb-2 text-xl font-semibold text-foreground">Load Confirmed</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Thank you — this load is confirmed. We&apos;re now securing a carrier and will keep you updated.
              A tracking link will replace this page once the load is dispatched.
            </p>
          </div>
        )}

        {view === "declined" && (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
              <XCircle className="h-7 w-7 text-destructive" />
            </div>
            <h1 className="mb-2 text-xl font-semibold text-foreground">Load Declined</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              We&apos;ve recorded your decline. Someone from our team will follow up with you directly to
              resolve this.
            </p>
          </div>
        )}
      </main>

      <footer className="border-t border-border/60 py-6 text-center">
        <p className="text-[10px] text-muted-foreground/50">&copy; {new Date().getFullYear()} Myra AI, Inc.</p>
      </footer>
    </div>
  )
}
