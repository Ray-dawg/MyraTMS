"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { useTenant } from "@/components/tenant-context"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Plus } from "lucide-react"
import { toast } from "sonner"

interface TenantRow {
  id: number
  slug: string
  name: string
  type: string
  status: string
  parent_tenant_id: number | null
  billing_email: string | null
  primary_admin_user_id: string | null
  created_at: string
  user_count: number
  load_count: number
}

const fetcher = async (url: string): Promise<{ tenants: TenantRow[]; count: number }> => {
  const res = await fetch(url, { credentials: "include" })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

export default function AdminTenantsPage() {
  const router = useRouter()
  const tenant = useTenant()
  const { data, error, isLoading, mutate } = useSWR(
    tenant?.user.isSuperAdmin ? "/api/admin/tenants" : null,
    fetcher,
  )

  const [createOpen, setCreateOpen] = useState(false)

  // Server enforcement is in /api/admin/tenants — this is the cosmetic gate.
  if (tenant && !tenant.user.isSuperAdmin) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold mb-2">Forbidden</h1>
        <p className="text-muted-foreground">
          Only super-admins can manage tenants.
        </p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Tenants</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {data ? `${data.count} active tenant${data.count === 1 ? "" : "s"}` : "Loading…"}
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New Tenant
            </Button>
          </DialogTrigger>
          <CreateTenantDialog
            onCreated={(id) => {
              setCreateOpen(false)
              mutate()
              router.push(`/admin/tenants/${id}/onboard`)
            }}
          />
        </Dialog>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load tenants: {String(error.message ?? error)}
        </div>
      ) : isLoading || !data ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">ID</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Users</TableHead>
                <TableHead className="text-right">Loads</TableHead>
                <TableHead className="w-32"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.tenants.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs">{t.id}</TableCell>
                  <TableCell className="font-medium">{t.slug}</TableCell>
                  <TableCell>{t.name}</TableCell>
                  <TableCell className="capitalize text-xs text-muted-foreground">
                    {t.type.replace(/_/g, " ")}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{t.user_count}</TableCell>
                  <TableCell className="text-right tabular-nums">{t.load_count}</TableCell>
                  <TableCell>
                    <Link
                      href={`/admin/tenants/${t.id}/onboard`}
                      className="text-sm text-primary hover:underline"
                    >
                      Onboard
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

// Module-level — per react-best-practices rerender-no-inline-components.
function StatusBadge({ status }: { status: string }) {
  const colorClass =
    status === "active"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : status === "trial"
        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : status === "suspended" || status === "past_due"
          ? "bg-rose-500/10 text-rose-700 dark:text-rose-400"
          : "bg-muted text-muted-foreground"
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colorClass}`}
    >
      {status}
    </span>
  )
}

function CreateTenantDialog({ onCreated }: { onCreated: (id: number) => void }) {
  const [slug, setSlug] = useState("")
  const [name, setName] = useState("")
  const [type, setType] = useState<"operating_company" | "saas_customer" | "internal">(
    "saas_customer",
  )
  const [billingEmail, setBillingEmail] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit() {
    setSubmitting(true)
    try {
      const res = await fetch("/api/admin/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          slug,
          name,
          type,
          billingEmail: billingEmail || null,
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast.error(body.error || "Failed to create tenant")
        return
      }
      toast.success(`Tenant '${slug}' created — proceed to onboarding`)
      onCreated(body.tenant.id)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Create Tenant</DialogTitle>
        <DialogDescription>
          Provisions an empty tenant record. The next step (Onboard) clones
          default config and seats the owner user.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="slug">Slug</Label>
          <Input
            id="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder="acme-logistics"
            autoCapitalize="none"
          />
          <p className="text-xs text-muted-foreground">
            Lowercase letters, digits, hyphens. 3–31 characters. Becomes the subdomain.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="name">Display name</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Logistics, Inc."
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="type">Type</Label>
          <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
            <SelectTrigger id="type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="saas_customer">SaaS customer</SelectItem>
              <SelectItem value="operating_company">Operating company</SelectItem>
              <SelectItem value="internal">Internal</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="billing-email">Billing email (optional)</Label>
          <Input
            id="billing-email"
            type="email"
            value={billingEmail}
            onChange={(e) => setBillingEmail(e.target.value)}
            placeholder="ops@acme-logistics.com"
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          onClick={handleSubmit}
          disabled={submitting || !slug || !name}
        >
          {submitting ? "Creating…" : "Create"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
