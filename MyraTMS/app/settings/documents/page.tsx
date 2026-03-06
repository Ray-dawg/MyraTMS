"use client"

import { useState, useEffect } from "react"
import { FileText, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { toast } from "sonner"

const DEFAULT_TERMS = `Carrier warrants active FMCSA operating authority and insurance meeting minimum requirements. Carrier is liable for loss or damage to cargo from pickup to delivery. Detention: 2 hours free time at each stop, $75/hour thereafter. TONU: $250 if cancelled after truck is dispatched. Carrier may not broker, re-broker, or assign this load without written consent.`

export default function DocumentSettingsPage() {
  const [terms, setTerms] = useState(DEFAULT_TERMS)
  const [autoSend, setAutoSend] = useState(false)
  const [savingTerms, setSavingTerms] = useState(false)
  const [savingAutoSend, setSavingAutoSend] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/settings?scope=global")
        if (res.ok) {
          const data = await res.json()
          const settings = data.settings || {}
          if (settings.rate_con_terms) {
            setTerms(typeof settings.rate_con_terms === "string" ? settings.rate_con_terms : String(settings.rate_con_terms))
          }
          if (settings.auto_send_rate_con !== undefined) {
            setAutoSend(Boolean(settings.auto_send_rate_con))
          }
        }
      } catch {
        // Use defaults
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  async function saveTerms() {
    setSavingTerms(true)
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "rate_con_terms", value: terms, scope: "global" }),
      })
      if (!res.ok) throw new Error()
      toast.success("Terms saved")
    } catch {
      toast.error("Failed to save terms")
    } finally {
      setSavingTerms(false)
    }
  }

  async function toggleAutoSend(checked: boolean) {
    setAutoSend(checked)
    setSavingAutoSend(true)
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "auto_send_rate_con", value: checked, scope: "global" }),
      })
      if (!res.ok) throw new Error()
      toast.success(checked ? "Auto-send enabled" : "Auto-send disabled")
    } catch {
      setAutoSend(!checked)
      toast.error("Failed to update setting")
    } finally {
      setSavingAutoSend(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Document Settings</h1>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">Configure rate confirmation templates and automation</p>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Rate Confirmation Terms</CardTitle>
            <CardDescription className="text-xs">
              This text appears in the Terms & Conditions section of all rate confirmations.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Terms Text</Label>
              <Textarea
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                rows={10}
                className="text-sm font-mono"
                placeholder="Enter rate confirmation terms..."
              />
            </div>
            <Button size="sm" className="text-xs gap-1.5" onClick={saveTerms} disabled={savingTerms}>
              {savingTerms && <Loader2 className="h-3 w-3 animate-spin" />}
              {savingTerms ? "Saving..." : "Save Terms"}
            </Button>
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Auto-Send Rate Confirmation</CardTitle>
            <CardDescription className="text-xs">
              Automatically send the rate confirmation to the carrier when they are assigned to a load.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-foreground">Enable auto-send</p>
                <p className="text-xs text-muted-foreground">Rate con will be sent to carrier contact on assignment</p>
              </div>
              <Switch
                checked={autoSend}
                onCheckedChange={toggleAutoSend}
                disabled={savingAutoSend}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
