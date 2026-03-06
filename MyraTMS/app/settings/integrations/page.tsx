"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { ArrowLeft, Settings, Eye, EyeOff, Loader2, CheckCircle, XCircle, Wifi } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useIntegrations } from "@/lib/api"
import { toast } from "sonner"

interface IntegrationDef {
  provider: string
  label: string
  description: string
  hasSecret: boolean
  configFields?: { key: string; label: string; type: "select" | "text"; options?: { value: string; label: string }[] }[]
}

const PROVIDERS: IntegrationDef[] = [
  { provider: "dat", label: "DAT RateView", description: "Real-time lane rate data from DAT", hasSecret: true },
  { provider: "truckstop", label: "Truckstop", description: "Rate analysis from Truckstop marketplace", hasSecret: false },
  {
    provider: "ai", label: "AI Provider", description: "AI-powered rate estimation",
    hasSecret: false,
    configFields: [
      { key: "provider", label: "Model Provider", type: "select", options: [{ value: "xai", label: "xAI (Grok)" }, { value: "claude", label: "Anthropic (Claude)" }, { value: "openai", label: "OpenAI" }] },
    ],
  },
  { provider: "mapbox", label: "Mapbox", description: "Geocoding and directions for distance calculation", hasSecret: false },
]

interface ProviderState {
  apiKey: string
  apiSecret: string
  enabled: boolean
  config: Record<string, string>
  showKey: boolean
  showSecret: boolean
  testing: boolean
  saving: boolean
  dbId: string | null
  lastSuccess: string | null
  lastError: string | null
  lastErrorMsg: string | null
}

export default function IntegrationsPage() {
  const { data: integrations, mutate } = useIntegrations()
  const [states, setStates] = useState<Record<string, ProviderState>>({})

  useEffect(() => {
    const s: Record<string, ProviderState> = {}
    for (const p of PROVIDERS) {
      const existing = (integrations as Record<string, unknown>[] | undefined)?.find(
        (i: Record<string, unknown>) => i.provider === p.provider
      )
      s[p.provider] = {
        apiKey: "",
        apiSecret: "",
        enabled: existing ? Boolean(existing.enabled) : false,
        config: (existing?.config as Record<string, string>) || {},
        showKey: false,
        showSecret: false,
        testing: false,
        saving: false,
        dbId: existing ? String(existing.id) : null,
        lastSuccess: existing?.last_success_at ? String(existing.last_success_at) : null,
        lastError: existing?.last_error_at ? String(existing.last_error_at) : null,
        lastErrorMsg: existing?.last_error_msg ? String(existing.last_error_msg) : null,
      }
    }
    setStates(s)
  }, [integrations])

  const update = (provider: string, patch: Partial<ProviderState>) => {
    setStates((prev) => ({ ...prev, [provider]: { ...prev[provider], ...patch } }))
  }

  const handleSave = async (provider: string) => {
    const s = states[provider]
    if (!s) return
    update(provider, { saving: true })
    try {
      await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiKey: s.apiKey || undefined,
          apiSecret: s.apiSecret || undefined,
          config: s.config,
          enabled: s.enabled,
        }),
      })
      toast.success(`${provider} integration saved`)
      mutate()
    } catch {
      toast.error("Failed to save integration")
    } finally {
      update(provider, { saving: false })
    }
  }

  const handleTest = async (provider: string) => {
    const s = states[provider]
    if (!s?.dbId) {
      toast.error("Save the integration first before testing")
      return
    }
    update(provider, { testing: true })
    try {
      const res = await fetch(`/api/integrations/${s.dbId}/test`, { method: "POST" })
      const data = await res.json()
      if (data.success) {
        toast.success(data.message)
      } else {
        toast.error(data.message)
      }
      mutate()
    } catch {
      toast.error("Connection test failed")
    } finally {
      update(provider, { testing: false })
    }
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <Button variant="ghost" size="sm" className="mb-2 -ml-2 text-xs text-muted-foreground" asChild>
          <Link href="/settings"><ArrowLeft className="h-3 w-3 mr-1" /> Settings</Link>
        </Button>
        <div className="flex items-center gap-2">
          <Settings className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Integrations</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">Configure external API connections for rate data</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {PROVIDERS.map((p) => {
          const s = states[p.provider]
          if (!s) return null

          return (
            <Card key={p.provider} className="border-border bg-card">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm text-card-foreground">{p.label}</CardTitle>
                  <div className="flex items-center gap-2">
                    {s.lastSuccess && !s.lastError ? (
                      <Badge variant="outline" className="text-[10px] border-green-300 text-green-600"><CheckCircle className="h-3 w-3 mr-1" />Connected</Badge>
                    ) : s.lastErrorMsg ? (
                      <Badge variant="outline" className="text-[10px] border-red-300 text-red-600"><XCircle className="h-3 w-3 mr-1" />Error</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">Not configured</Badge>
                    )}
                    <Switch checked={s.enabled} onCheckedChange={(checked) => update(p.provider, { enabled: checked })} />
                  </div>
                </div>
                <CardDescription className="text-xs">{p.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">API Key</Label>
                  <div className="relative">
                    <Input
                      type={s.showKey ? "text" : "password"}
                      value={s.apiKey}
                      onChange={(e) => update(p.provider, { apiKey: e.target.value })}
                      placeholder="Enter API key..."
                      className="h-8 text-xs pr-8"
                    />
                    <button
                      type="button"
                      onClick={() => update(p.provider, { showKey: !s.showKey })}
                      className="absolute right-2 top-1.5 text-muted-foreground hover:text-foreground"
                    >
                      {s.showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>

                {p.hasSecret && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">API Secret</Label>
                    <div className="relative">
                      <Input
                        type={s.showSecret ? "text" : "password"}
                        value={s.apiSecret}
                        onChange={(e) => update(p.provider, { apiSecret: e.target.value })}
                        placeholder="Enter API secret..."
                        className="h-8 text-xs pr-8"
                      />
                      <button
                        type="button"
                        onClick={() => update(p.provider, { showSecret: !s.showSecret })}
                        className="absolute right-2 top-1.5 text-muted-foreground hover:text-foreground"
                      >
                        {s.showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                )}

                {p.configFields?.map((field) => (
                  <div key={field.key} className="space-y-1.5">
                    <Label className="text-xs">{field.label}</Label>
                    {field.type === "select" ? (
                      <Select
                        value={s.config[field.key] || ""}
                        onValueChange={(v) => update(p.provider, { config: { ...s.config, [field.key]: v } })}
                      >
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select..." /></SelectTrigger>
                        <SelectContent>
                          {field.options?.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={s.config[field.key] || ""}
                        onChange={(e) => update(p.provider, { config: { ...s.config, [field.key]: e.target.value } })}
                        className="h-8 text-xs"
                      />
                    )}
                  </div>
                ))}

                {s.lastErrorMsg && (
                  <p className="text-[10px] text-red-500 truncate" title={s.lastErrorMsg}>
                    Last error: {s.lastErrorMsg}
                  </p>
                )}
                {s.lastSuccess && (
                  <p className="text-[10px] text-muted-foreground">
                    Last success: {new Date(s.lastSuccess).toLocaleString()}
                  </p>
                )}

                <div className="flex gap-2 pt-1">
                  <Button size="sm" className="text-xs flex-1" onClick={() => handleSave(p.provider)} disabled={s.saving}>
                    {s.saving && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                    Save
                  </Button>
                  <Button size="sm" variant="outline" className="text-xs" onClick={() => handleTest(p.provider)} disabled={s.testing || !s.dbId}>
                    {s.testing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Wifi className="h-3 w-3 mr-1" />}
                    Test
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
