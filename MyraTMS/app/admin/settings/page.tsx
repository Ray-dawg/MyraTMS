"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { useTenant } from "@/components/tenant-context"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Lock, Pencil } from "lucide-react"
import { toast } from "sonner"

interface ConfigRow {
  key: string
  value: unknown
  encrypted: boolean
  hasValue: boolean
  description: string
  updatedAt: string | null
  updatedBy: string | null
}

const fetcher = async (url: string): Promise<{ tenantId: number; config: ConfigRow[] }> => {
  const res = await fetch(url, { credentials: "include" })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

// Group config keys by their topical prefix so the UI is scannable.
// Prefix → human-readable section title.
const SECTION_PREFIXES: Array<{ match: RegExp; title: string }> = [
  { match: /^(currency|locale|timezone|language)/, title: "Localization" },
  { match: /^(margin|walk_away|checkcall|detention)/, title: "Operations" },
  { match: /^(persona|auto_book|shipper_fatigue)/, title: "AutoBroker" },
  { match: /^branding_/, title: "Branding" },
  { match: /^(smtp|factoring|custom_smtp)/, title: "Communication" },
  { match: /^notif_/, title: "Notifications" },
  // Encrypted credentials get their own bucket regardless of name match.
  { match: /.*/, title: "Credentials" },
]

function sectionFor(row: ConfigRow): string {
  if (row.encrypted) return "Credentials"
  for (const s of SECTION_PREFIXES) {
    if (s.match.test(row.key)) return s.title
  }
  return "Other"
}

export default function AdminSettingsPage() {
  const tenant = useTenant()
  const { data, error, isLoading, mutate } = useSWR(
    tenant ? "/api/admin/config" : null,
    fetcher,
  )

  const [editing, setEditing] = useState<ConfigRow | null>(null)

  const grouped = useMemo(() => {
    if (!data) return []
    const buckets: Record<string, ConfigRow[]> = {}
    for (const row of data.config) {
      const sec = sectionFor(row)
      ;(buckets[sec] ||= []).push(row)
    }
    // Stable section order: same order as SECTION_PREFIXES.
    const order = ["Localization", "Operations", "AutoBroker", "Branding", "Communication", "Notifications", "Credentials", "Other"]
    return order
      .filter((s) => buckets[s])
      .map((s) => ({ section: s, rows: buckets[s] }))
  }, [data])

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Tenant Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {tenant ? `${tenant.tenant.name} • Tier: ${tenant.subscription.tier}` : "Loading…"}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {String(error.message ?? error)}
        </div>
      ) : isLoading || !data ? (
        <p className="text-muted-foreground">Loading config…</p>
      ) : (
        <div className="space-y-8">
          {grouped.map(({ section, rows }) => (
            <section key={section}>
              <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
                {section}
              </h2>
              <div className="rounded-md border divide-y">
                {rows.map((row) => (
                  <ConfigItem key={row.key} row={row} onEdit={() => setEditing(row)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        {editing && (
          <EditConfigDialog
            row={editing}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null)
              mutate()
            }}
          />
        )}
      </Dialog>
    </div>
  )
}

// --- Module-level subcomponents --------------------------------------------

function ConfigItem({ row, onEdit }: { row: ConfigRow; onEdit: () => void }) {
  const display = !row.hasValue
    ? "(not set)"
    : row.encrypted
      ? String(row.value ?? "")
      : JSON.stringify(row.value)

  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <code className="text-sm font-mono">{row.key}</code>
          {row.encrypted && (
            <Lock className="h-3 w-3 text-muted-foreground" aria-label="encrypted" />
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{row.description}</p>
        <p className="text-sm font-mono mt-1 text-foreground/80 truncate">{display}</p>
      </div>
      <Button variant="ghost" size="sm" onClick={onEdit} className="shrink-0">
        <Pencil className="h-3.5 w-3.5 mr-1.5" />
        Edit
      </Button>
    </div>
  )
}

function EditConfigDialog({
  row,
  onClose,
  onSaved,
}: {
  row: ConfigRow
  onClose: () => void
  onSaved: () => void
}) {
  const initial = row.encrypted
    ? "" // never seed plaintext for encrypted fields
    : row.hasValue
      ? typeof row.value === "string"
        ? row.value
        : JSON.stringify(row.value)
      : ""
  const [draft, setDraft] = useState(initial)
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function handleSave() {
    setSubmitting(true)
    try {
      // For encrypted keys we send the plaintext verbatim. For plaintext
      // keys we attempt to JSON.parse first (so "150" → 150, "true" → true);
      // fall back to the raw string if parse fails.
      let parsed: unknown = draft
      if (!row.encrypted) {
        try {
          parsed = JSON.parse(draft)
        } catch {
          parsed = draft
        }
      }
      const res = await fetch(`/api/admin/config/${encodeURIComponent(row.key)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ value: parsed, reason }),
      })
      const body = await res.json()
      if (!res.ok) {
        toast.error(body.error || "Update failed")
        return
      }
      toast.success(`Updated ${row.key}`)
      onSaved()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          <code className="text-sm font-mono">{row.key}</code>
        </DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground">{row.description}</p>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="value">Value</Label>
          {row.encrypted ? (
            <Input
              id="value"
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="(enter new credential — current value is masked)"
            />
          ) : (
            <Input
              id="value"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="JSON-encoded value (e.g. 150, &quot;CAD&quot;, true, null)"
            />
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="reason">Reason (audit trail)</Label>
          <Textarea
            id="reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this changing?"
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={submitting || reason.length < 5 || (row.encrypted && !draft)}
        >
          {submitting ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
