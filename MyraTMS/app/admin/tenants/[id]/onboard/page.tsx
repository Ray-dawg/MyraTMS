"use client"

import { useState, use } from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { useTenant } from "@/components/tenant-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ChevronLeft, ChevronRight, Check } from "lucide-react"
import { toast } from "sonner"

// ---------------------------------------------------------------------------
// Onboarding wizard for a freshly-created tenant.
//
// Three steps:
//   1. Confirm tenant details (read-only review)
//   2. Choose owner user — must already exist (auth/invite + accept-invite
//      flow creates the user; this just seats them in tenant_users)
//   3. Review + submit — POSTs /api/admin/tenants/[id]/onboard
//
// Per react-best-practices `rerender-no-inline-components`, each step is a
// module-level function component. The wizard parent owns state and passes
// it down via props.
// ---------------------------------------------------------------------------

interface TenantDetails {
  id: number
  slug: string
  name: string
  type: string
  status: string
  primary_admin_user_id: string | null
  user_count: number
  config_count: number
  load_count: number
}

const tenantFetcher = async (url: string): Promise<{ tenant: TenantDetails }> => {
  const res = await fetch(url, { credentials: "include" })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

export default function OnboardWizardPage({
  params,
}: {
  // Next.js 16 — params is a Promise; unwrap with React.use()
  params: Promise<{ id: string }>
}) {
  const router = useRouter()
  const { id: rawId } = use(params)
  const tenant = useTenant()

  const { data, error, isLoading, mutate } = useSWR(
    tenant?.user.isSuperAdmin ? `/api/admin/tenants/${rawId}` : null,
    tenantFetcher,
  )

  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [ownerUserId, setOwnerUserId] = useState("")
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)

  if (tenant && !tenant.user.isSuperAdmin) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold mb-2">Forbidden</h1>
        <p className="text-muted-foreground">
          Only super-admins can run tenant onboarding.
        </p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold mb-2">Tenant not found</h1>
        <p className="text-muted-foreground">{String(error.message ?? error)}</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push("/admin/tenants")}>
          Back to tenants
        </Button>
      </div>
    )
  }

  if (isLoading || !data) {
    return <div className="p-8 text-muted-foreground">Loading tenant…</div>
  }

  async function handleSubmit() {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/admin/tenants/${rawId}/onboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          ownerUserId,
          reason,
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast.error(body.error || "Onboarding failed")
        return
      }
      toast.success(
        `Onboarded — ${body.configRowsAdded} config rows added, owner ${body.ownerSeated ? "seated" : "already a member"}`,
      )
      mutate()
      router.push("/admin/tenants")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <button
        onClick={() => router.push("/admin/tenants")}
        className="text-sm text-muted-foreground hover:text-foreground mb-4 flex items-center gap-1"
      >
        <ChevronLeft className="h-4 w-4" />
        Back to tenants
      </button>

      <h1 className="text-2xl font-semibold mb-2">Onboard Tenant</h1>
      <p className="text-sm text-muted-foreground mb-6">
        {data.tenant.name} <span className="text-xs">({data.tenant.slug})</span>
      </p>

      <Stepper current={step} />

      <div className="mt-6 rounded-md border bg-card p-6">
        {step === 1 && <StepReviewDetails tenant={data.tenant} />}
        {step === 2 && (
          <StepOwner
            ownerUserId={ownerUserId}
            onChange={setOwnerUserId}
            initialOwnerHint={data.tenant.primary_admin_user_id}
          />
        )}
        {step === 3 && (
          <StepConfirm
            tenant={data.tenant}
            ownerUserId={ownerUserId}
            reason={reason}
            onReasonChange={setReason}
          />
        )}
      </div>

      <div className="mt-6 flex justify-between">
        <Button
          variant="outline"
          disabled={step === 1}
          onClick={() => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3) : s))}
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        {step < 3 ? (
          <Button
            onClick={() => setStep((s) => ((s + 1) as 1 | 2 | 3))}
            disabled={step === 2 && !ownerUserId.trim()}
          >
            Next
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        ) : (
          <Button
            onClick={handleSubmit}
            disabled={submitting || !ownerUserId || reason.length < 5}
          >
            {submitting ? "Onboarding…" : "Submit"}
            <Check className="h-4 w-4 ml-1" />
          </Button>
        )}
      </div>
    </div>
  )
}

// --- Module-level step components -----------------------------------------

function Stepper({ current }: { current: 1 | 2 | 3 }) {
  const steps = ["Review", "Owner", "Confirm"]
  return (
    <ol className="flex items-center gap-2">
      {steps.map((label, i) => {
        const stepN = i + 1
        const isActive = stepN === current
        const isDone = stepN < current
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium border ${
                isActive
                  ? "bg-primary text-primary-foreground border-primary"
                  : isDone
                    ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-400"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {isDone ? <Check className="h-3 w-3" /> : stepN}
            </span>
            <span
              className={`text-sm ${isActive ? "font-medium" : "text-muted-foreground"}`}
            >
              {label}
            </span>
            {stepN < steps.length && <span className="w-8 h-px bg-border" />}
          </li>
        )
      })}
    </ol>
  )
}

function StepReviewDetails({ tenant }: { tenant: TenantDetails }) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">Review tenant details</h2>
      <p className="text-sm text-muted-foreground">
        These were captured at tenant creation. To change them, cancel and use
        the tenant edit form first.
      </p>
      <dl className="grid grid-cols-2 gap-y-3 gap-x-6 text-sm">
        <dt className="text-muted-foreground">Slug</dt>
        <dd className="font-mono">{tenant.slug}</dd>

        <dt className="text-muted-foreground">Name</dt>
        <dd>{tenant.name}</dd>

        <dt className="text-muted-foreground">Type</dt>
        <dd className="capitalize">{tenant.type.replace(/_/g, " ")}</dd>

        <dt className="text-muted-foreground">Current status</dt>
        <dd className="capitalize">{tenant.status}</dd>

        <dt className="text-muted-foreground">Existing config rows</dt>
        <dd>{tenant.config_count}</dd>

        <dt className="text-muted-foreground">Members</dt>
        <dd>{tenant.user_count}</dd>
      </dl>
      {tenant.config_count > 0 && (
        <div className="rounded-md bg-amber-500/10 border border-amber-500/30 p-3 text-xs text-amber-800 dark:text-amber-300">
          This tenant already has {tenant.config_count} config rows. Onboarding
          is idempotent — existing values are preserved; only missing defaults
          are added.
        </div>
      )}
    </div>
  )
}

function StepOwner({
  ownerUserId,
  onChange,
  initialOwnerHint,
}: {
  ownerUserId: string
  onChange: (id: string) => void
  initialOwnerHint: string | null
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">Choose owner user</h2>
      <p className="text-sm text-muted-foreground">
        The owner gets <code>role=&apos;owner&apos;</code> in <code>tenant_users</code>{" "}
        and is the default admin contact. The user must already exist —
        invite them via <code>/api/auth/invite</code> first if needed.
      </p>
      <div className="space-y-2">
        <Label htmlFor="owner">Owner user ID</Label>
        <Input
          id="owner"
          value={ownerUserId}
          onChange={(e) => onChange(e.target.value)}
          placeholder={initialOwnerHint || "usr-..."}
        />
        {initialOwnerHint && !ownerUserId && (
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => onChange(initialOwnerHint)}
          >
            Use existing primary_admin_user_id ({initialOwnerHint})
          </button>
        )}
      </div>
    </div>
  )
}

function StepConfirm({
  tenant,
  ownerUserId,
  reason,
  onReasonChange,
}: {
  tenant: TenantDetails
  ownerUserId: string
  reason: string
  onReasonChange: (v: string) => void
}) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">Confirm and submit</h2>
      <ul className="text-sm space-y-1 list-disc list-inside text-muted-foreground">
        <li>
          Clone <strong>DEFAULT_TENANT_CONFIG</strong> into{" "}
          <code>tenant_config</code> (keys already present are preserved)
        </li>
        <li>
          Seat <code className="font-mono">{ownerUserId || "<owner>"}</code> as
          owner in <code>tenant_users</code>
        </li>
        <li>
          Stamp <code>tenants.primary_admin_user_id</code>; flip{" "}
          <code>status=&apos;trial&apos;</code> →{" "}
          <code>&apos;active&apos;</code> if currently trial
          {tenant.status === "trial"
            ? " (status will change)"
            : ` (status stays '${tenant.status}')`}
        </li>
        <li>Write a tenant_audit_log entry for this onboarding</li>
      </ul>
      <div className="space-y-2">
        <Label htmlFor="reason">Reason (audit trail)</Label>
        <Textarea
          id="reason"
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
          rows={3}
          placeholder="e.g. New customer onboarded after Q2 sales contract signed"
        />
        <p className="text-xs text-muted-foreground">
          Required, minimum 5 characters. Recorded in tenant_audit_log.
        </p>
      </div>
    </div>
  )
}
