"use client"

import { useState, useEffect, useCallback } from "react"
import { Settings, User, Bell, Shield, Palette, Building2, Loader2, FileSpreadsheet, Plug, DollarSign, Users, Mail, Copy, Check, Clock, UserPlus } from "lucide-react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useWorkspace } from "@/lib/workspace-context"
import { useTheme } from "next-themes"
import { toast } from "sonner"

// -------------------------------------------------------------------
// Default setting values (used before first fetch or if key is absent)
// -------------------------------------------------------------------
const NOTIFICATION_DEFAULTS: Record<string, boolean> = {
  notif_ai_risk_alerts: true,
  notif_load_status_updates: true,
  notif_invoice_reminders: true,
  notif_document_uploads: false,
  notif_weekly_digest: true,
}

const BROKERAGE_DEFAULTS: Record<string, string> = {
  company_name: "Myra Freight Brokerage",
  mc_number: "MC-891234",
  dot_number: "3456789",
  default_target_margin: "22",
  default_payment_terms: "net30",
}

const APPEARANCE_DEFAULTS: Record<string, boolean> = {
  compact_tables: false,
  sidebar_collapsed: false,
}

// -------------------------------------------------------------------
// Notification config for rendering
// -------------------------------------------------------------------
const NOTIFICATION_ITEMS = [
  { key: "notif_ai_risk_alerts", label: "AI Risk Alerts", description: "Get notified when AI flags at-risk loads or carriers" },
  { key: "notif_load_status_updates", label: "Load Status Updates", description: "Notifications for pickup, delivery, and status changes" },
  { key: "notif_invoice_reminders", label: "Invoice Reminders", description: "Alerts for overdue invoices and payment confirmations" },
  { key: "notif_document_uploads", label: "Document Uploads", description: "Notify when BOLs, PODs, or rate confirmations are uploaded" },
  { key: "notif_weekly_digest", label: "Weekly Digest", description: "Summary of operations, margins, and AI insights every Monday" },
]

export default function SettingsPage() {
  const { profile, updateProfile } = useWorkspace()
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  // ----- Loading state -----
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)

  // ----- Profile fields (saved to /api/auth/me) -----
  const [profileFields, setProfileFields] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    role: "admin",
  })

  // ----- Notification settings -----
  const [notifSettings, setNotifSettings] = useState<Record<string, boolean>>({ ...NOTIFICATION_DEFAULTS })

  // ----- Check-call reminder settings (global scope) -----
  const [checkcallThreshold, setCheckcallThreshold] = useState("4")
  const [checkcallEnabled, setCheckcallEnabled] = useState(true)

  // ----- Brokerage settings -----
  const [brokerageSettings, setBrokerageSettings] = useState<Record<string, string>>({ ...BROKERAGE_DEFAULTS })

  // ----- Appearance settings -----
  const [appearanceSettings, setAppearanceSettings] = useState<Record<string, boolean>>({ ...APPEARANCE_DEFAULTS })

  // ----- Security / password -----
  const [passwords, setPasswords] = useState({ current: "", new: "", confirm: "" })

  // Hydration guard for theme
  useEffect(() => { setMounted(true) }, [])

  // ----- Populate profile fields from workspace context -----
  useEffect(() => {
    setProfileFields({
      firstName: profile.firstName,
      lastName: profile.lastName,
      email: profile.email,
      phone: profile.phone,
      role: profile.role,
    })
  }, [profile])

  // ----- Fetch settings on mount -----
  useEffect(() => {
    async function fetchSettings() {
      try {
        const res = await fetch("/api/settings")
        if (!res.ok) return
        const data = await res.json()
        const s = data.settings || {}

        // Apply fetched values over defaults
        setNotifSettings((prev) => {
          const next = { ...prev }
          for (const key of Object.keys(prev)) {
            if (s[key] !== undefined) next[key] = s[key]
          }
          return next
        })

        setBrokerageSettings((prev) => {
          const next = { ...prev }
          for (const key of Object.keys(prev)) {
            if (s[key] !== undefined) next[key] = String(s[key])
          }
          return next
        })

        setAppearanceSettings((prev) => {
          const next = { ...prev }
          for (const key of Object.keys(prev)) {
            if (s[key] !== undefined) next[key] = s[key]
          }
          return next
        })

        // Sync dark mode from DB if it was stored
        if (s.dark_mode !== undefined) {
          setTheme(s.dark_mode ? "dark" : "light")
        }

        // Fetch global check-call settings
        try {
          const globalRes = await fetch("/api/settings?scope=global")
          if (globalRes.ok) {
            const globalData = await globalRes.json()
            const gs = globalData.settings || {}
            if (gs.checkcall_threshold_hours !== undefined) {
              setCheckcallThreshold(String(gs.checkcall_threshold_hours))
            }
            if (gs.notif_checkcall_enabled !== undefined) {
              setCheckcallEnabled(gs.notif_checkcall_enabled === true || gs.notif_checkcall_enabled === "true")
            }
          }
        } catch {
          // Keep defaults
        }
      } catch {
        // Network error — keep defaults
      } finally {
        setLoading(false)
      }
    }

    fetchSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ----- Save helpers -----
  const saveSettings = useCallback(async (settings: Record<string, unknown>, label: string) => {
    setSaving(label)
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to save")
      }
      toast.success(`${label} saved successfully`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to save"
      toast.error(message)
    } finally {
      setSaving(null)
    }
  }, [])

  const handleSaveProfile = async () => {
    setSaving("profile")
    try {
      const res = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: profileFields.firstName,
          lastName: profileFields.lastName,
          phone: profileFields.phone,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to save profile")
      }
      // Update workspace context
      updateProfile({
        firstName: profileFields.firstName,
        lastName: profileFields.lastName,
        phone: profileFields.phone,
      })
      toast.success("Profile updated successfully")
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to save profile"
      toast.error(message)
    } finally {
      setSaving(null)
    }
  }

  const handleSaveNotifications = () => {
    saveSettings(notifSettings, "Notification preferences")
  }

  const handleSaveCheckcall = async () => {
    setSaving("Check-call reminders")
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "global",
          settings: {
            checkcall_threshold_hours: checkcallThreshold,
            notif_checkcall_enabled: checkcallEnabled,
          },
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to save")
      }
      toast.success("Check-call reminders saved successfully")
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to save"
      toast.error(message)
    } finally {
      setSaving(null)
    }
  }

  const handleSaveBrokerage = () => {
    saveSettings(brokerageSettings as Record<string, unknown>, "Brokerage configuration")
  }

  const handleSaveAppearance = async () => {
    const darkMode = theme === "dark"
    await saveSettings({ ...appearanceSettings, dark_mode: darkMode }, "Display preferences")
  }

  const handleUpdatePassword = async () => {
    if (passwords.new !== passwords.confirm) {
      toast.error("Passwords do not match")
      return
    }
    if (passwords.new.length < 8) {
      toast.error("Password must be at least 8 characters")
      return
    }
    setSaving("password")
    try {
      const res = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: passwords.current,
          newPassword: passwords.new,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to update password")
      }
      toast.success("Password updated successfully")
      setPasswords({ current: "", new: "", confirm: "" })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update password"
      toast.error(message)
    } finally {
      setSaving(null)
    }
  }

  const handleToggleDarkMode = (checked: boolean) => {
    setTheme(checked ? "dark" : "light")
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading settings...</span>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Settings className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Settings</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          Manage your account, preferences, and brokerage configuration
        </p>
      </div>

      <Tabs defaultValue="profile" className="space-y-4">
        <TabsList className="bg-secondary/50">
          <TabsTrigger value="profile" className="gap-1.5 text-xs">
            <User className="h-3.5 w-3.5" />
            Profile
          </TabsTrigger>
          <TabsTrigger value="notifications" className="gap-1.5 text-xs">
            <Bell className="h-3.5 w-3.5" />
            Notifications
          </TabsTrigger>
          <TabsTrigger value="brokerage" className="gap-1.5 text-xs">
            <Building2 className="h-3.5 w-3.5" />
            Brokerage
          </TabsTrigger>
          <TabsTrigger value="appearance" className="gap-1.5 text-xs">
            <Palette className="h-3.5 w-3.5" />
            Appearance
          </TabsTrigger>
          <TabsTrigger value="security" className="gap-1.5 text-xs">
            <Shield className="h-3.5 w-3.5" />
            Security
          </TabsTrigger>
          <TabsTrigger value="team" className="gap-1.5 text-xs">
            <Users className="h-3.5 w-3.5" />
            Team
          </TabsTrigger>
          <TabsTrigger value="integrations" className="gap-1.5 text-xs" asChild>
            <Link href="/settings/integrations">
              <Plug className="h-3.5 w-3.5" />
              Integrations
            </Link>
          </TabsTrigger>
          <TabsTrigger value="rates" className="gap-1.5 text-xs" asChild>
            <Link href="/settings/rates">
              <DollarSign className="h-3.5 w-3.5" />
              Rates
            </Link>
          </TabsTrigger>
          <TabsTrigger value="import" className="gap-1.5 text-xs" asChild>
            <Link href="/settings/import">
              <FileSpreadsheet className="h-3.5 w-3.5" />
              Bulk Import
            </Link>
          </TabsTrigger>
        </TabsList>

        {/* ---- Profile Tab ---- */}
        <TabsContent value="profile">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-sm text-card-foreground">Personal Information</CardTitle>
              <CardDescription className="text-xs">Update your personal details and contact info.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">First Name</Label>
                  <Input
                    value={profileFields.firstName}
                    onChange={(e) => setProfileFields((p) => ({ ...p, firstName: e.target.value }))}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Last Name</Label>
                  <Input
                    value={profileFields.lastName}
                    onChange={(e) => setProfileFields((p) => ({ ...p, lastName: e.target.value }))}
                    className="h-9 text-sm"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Email</Label>
                <Input
                  value={profileFields.email}
                  disabled
                  className="h-9 text-sm opacity-60"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Phone</Label>
                <Input
                  value={profileFields.phone}
                  onChange={(e) => setProfileFields((p) => ({ ...p, phone: e.target.value }))}
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Role</Label>
                <Select value={profileFields.role} disabled>
                  <SelectTrigger className="h-9 text-sm opacity-60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="ops">Operations</SelectItem>
                    <SelectItem value="sales">Sales</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="text-xs"
                  onClick={handleSaveProfile}
                  disabled={saving === "profile"}
                >
                  {saving === "profile" && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                  Save Changes
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Notifications Tab ---- */}
        <TabsContent value="notifications">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-sm text-card-foreground">Notification Preferences</CardTitle>
              <CardDescription className="text-xs">Choose what alerts you receive and how.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {NOTIFICATION_ITEMS.map((item) => (
                <div key={item.key} className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-card-foreground">{item.label}</p>
                    <p className="text-xs text-muted-foreground">{item.description}</p>
                  </div>
                  <Switch
                    checked={notifSettings[item.key] ?? false}
                    onCheckedChange={(checked) =>
                      setNotifSettings((prev) => ({ ...prev, [item.key]: checked }))
                    }
                  />
                </div>
              ))}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="text-xs"
                  onClick={handleSaveNotifications}
                  disabled={saving === "Notification preferences"}
                >
                  {saving === "Notification preferences" && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                  Save Preferences
                </Button>
              </div>

              <Separator />

              <div>
                <p className="text-sm font-medium text-card-foreground">Check-Call Reminders</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Automatically flag in-transit loads when no GPS ping or check-call has been received within the configured window.
                </p>
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-card-foreground">Enable Check-Call Alerts</p>
                  <p className="text-xs text-muted-foreground">Generate exceptions for missing contact on in-transit loads</p>
                </div>
                <Switch
                  checked={checkcallEnabled}
                  onCheckedChange={setCheckcallEnabled}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Alert Threshold (hours without contact)</Label>
                <Select
                  value={checkcallThreshold}
                  onValueChange={setCheckcallThreshold}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="2">2 hours</SelectItem>
                    <SelectItem value="3">3 hours</SelectItem>
                    <SelectItem value="4">4 hours</SelectItem>
                    <SelectItem value="6">6 hours</SelectItem>
                    <SelectItem value="8">8 hours</SelectItem>
                    <SelectItem value="12">12 hours</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="text-xs"
                  onClick={handleSaveCheckcall}
                  disabled={saving === "Check-call reminders"}
                >
                  {saving === "Check-call reminders" && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                  Save Check-Call Settings
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Brokerage Tab ---- */}
        <TabsContent value="brokerage">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-sm text-card-foreground">Brokerage Configuration</CardTitle>
              <CardDescription className="text-xs">Manage your brokerage details and operational defaults.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Company Name</Label>
                <Input
                  value={brokerageSettings.company_name}
                  onChange={(e) => setBrokerageSettings((p) => ({ ...p, company_name: e.target.value }))}
                  className="h-9 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">MC Number</Label>
                  <Input
                    value={brokerageSettings.mc_number}
                    onChange={(e) => setBrokerageSettings((p) => ({ ...p, mc_number: e.target.value }))}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">DOT Number</Label>
                  <Input
                    value={brokerageSettings.dot_number}
                    onChange={(e) => setBrokerageSettings((p) => ({ ...p, dot_number: e.target.value }))}
                    className="h-9 text-sm"
                  />
                </div>
              </div>
              <Separator />
              <div className="space-y-1.5">
                <Label className="text-xs">Default Target Margin</Label>
                <Select
                  value={brokerageSettings.default_target_margin}
                  onValueChange={(v) => setBrokerageSettings((p) => ({ ...p, default_target_margin: v }))}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="18">18%</SelectItem>
                    <SelectItem value="20">20%</SelectItem>
                    <SelectItem value="22">22%</SelectItem>
                    <SelectItem value="25">25%</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Default Payment Terms</Label>
                <Select
                  value={brokerageSettings.default_payment_terms}
                  onValueChange={(v) => setBrokerageSettings((p) => ({ ...p, default_payment_terms: v }))}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="net15">Net 15</SelectItem>
                    <SelectItem value="net30">Net 30</SelectItem>
                    <SelectItem value="net45">Net 45</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="text-xs"
                  onClick={handleSaveBrokerage}
                  disabled={saving === "Brokerage configuration"}
                >
                  {saving === "Brokerage configuration" && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                  Save Configuration
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Appearance Tab ---- */}
        <TabsContent value="appearance">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-sm text-card-foreground">Display Preferences</CardTitle>
              <CardDescription className="text-xs">Customize your interface appearance.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-card-foreground">Dark Mode</p>
                  <p className="text-xs text-muted-foreground">Toggle between light and dark theme</p>
                </div>
                <Switch
                  checked={mounted ? theme === "dark" : false}
                  onCheckedChange={handleToggleDarkMode}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-card-foreground">Compact Tables</p>
                  <p className="text-xs text-muted-foreground">Reduce row height in data tables</p>
                </div>
                <Switch
                  checked={appearanceSettings.compact_tables}
                  onCheckedChange={(checked) =>
                    setAppearanceSettings((p) => ({ ...p, compact_tables: checked }))
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-card-foreground">Sidebar Collapsed by Default</p>
                  <p className="text-xs text-muted-foreground">Start with the sidebar minimized</p>
                </div>
                <Switch
                  checked={appearanceSettings.sidebar_collapsed}
                  onCheckedChange={(checked) =>
                    setAppearanceSettings((p) => ({ ...p, sidebar_collapsed: checked }))
                  }
                />
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="text-xs"
                  onClick={handleSaveAppearance}
                  disabled={saving === "Display preferences"}
                >
                  {saving === "Display preferences" && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                  Save Preferences
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---- Security Tab ---- */}
        <TabsContent value="security">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-sm text-card-foreground">Security Settings</CardTitle>
              <CardDescription className="text-xs">Manage your password and security preferences.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Current Password</Label>
                <Input
                  type="password"
                  value={passwords.current}
                  onChange={(e) => setPasswords((p) => ({ ...p, current: e.target.value }))}
                  className="h-9 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">New Password</Label>
                  <Input
                    type="password"
                    value={passwords.new}
                    onChange={(e) => setPasswords((p) => ({ ...p, new: e.target.value }))}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Confirm Password</Label>
                  <Input
                    type="password"
                    value={passwords.confirm}
                    onChange={(e) => setPasswords((p) => ({ ...p, confirm: e.target.value }))}
                    className="h-9 text-sm"
                  />
                </div>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-card-foreground">Two-Factor Authentication</p>
                  <p className="text-xs text-muted-foreground">Add an extra layer of security to your account</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => toast.info("2FA setup coming soon")}
                >
                  Enable 2FA
                </Button>
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="text-xs"
                  onClick={handleUpdatePassword}
                  disabled={!passwords.current || !passwords.new || saving === "password"}
                >
                  {saving === "password" && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                  Update Password
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        {/* ---- Team Tab ---- */}
        <TabsContent value="team">
          <TeamInviteSection />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ===== Team Invite Section (separate component to keep settings page manageable) =====

function TeamInviteSection() {
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState("broker")
  const [inviteFirstName, setInviteFirstName] = useState("")
  const [inviteLastName, setInviteLastName] = useState("")
  const [sending, setSending] = useState(false)
  const [lastInviteUrl, setLastInviteUrl] = useState("")
  const [copied, setCopied] = useState(false)
  const [invites, setInvites] = useState<Array<{
    id: string; email: string; role: string; display_status: string;
    expires_at: string; created_at: string; first_name: string | null; last_name: string | null
  }>>([])
  const [loadingInvites, setLoadingInvites] = useState(true)

  useEffect(() => {
    fetch("/api/auth/invite")
      .then(res => res.ok ? res.json() : { invites: [] })
      .then(data => setInvites(data.invites || []))
      .catch(() => {})
      .finally(() => setLoadingInvites(false))
  }, [])

  async function handleSendInvite() {
    if (!inviteEmail) {
      toast.error("Email is required")
      return
    }
    setSending(true)
    setLastInviteUrl("")

    try {
      const res = await fetch("/api/auth/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: inviteEmail,
          role: inviteRole,
          firstName: inviteFirstName || undefined,
          lastName: inviteLastName || undefined,
        }),
      })
      const data = await res.json()

      if (res.ok) {
        toast.success(`Invitation sent to ${inviteEmail}`)
        setLastInviteUrl(data.invite.inviteUrl)
        if (!data.invite.emailSent) {
          toast.info("SMTP not configured — copy the invite link below to share manually")
        }
        setInviteEmail("")
        setInviteFirstName("")
        setInviteLastName("")
        // Refresh invite list
        const listRes = await fetch("/api/auth/invite")
        if (listRes.ok) {
          const listData = await listRes.json()
          setInvites(listData.invites || [])
        }
      } else {
        toast.error(data.error || "Failed to send invitation")
      }
    } catch {
      toast.error("Network error")
    } finally {
      setSending(false)
    }
  }

  function copyInviteUrl() {
    navigator.clipboard.writeText(lastInviteUrl)
    setCopied(true)
    toast.success("Invite link copied!")
    setTimeout(() => setCopied(false), 2000)
  }

  const statusColors: Record<string, string> = {
    pending: "bg-amber-500/15 text-amber-600",
    accepted: "bg-green-500/15 text-green-600",
    expired: "bg-zinc-500/15 text-zinc-500",
    revoked: "bg-red-500/15 text-red-600",
  }

  return (
    <div className="space-y-6">
      {/* Send Invite Card */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-sm text-card-foreground flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            Invite Team Member
          </CardTitle>
          <CardDescription className="text-xs">
            Send an invite to add a new broker or admin. They&apos;ll receive an email with a link to create their account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">First Name</Label>
              <Input
                placeholder="Jane"
                value={inviteFirstName}
                onChange={(e) => setInviteFirstName(e.target.value)}
                className="text-sm"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Last Name</Label>
              <Input
                placeholder="Smith"
                value={inviteLastName}
                onChange={(e) => setInviteLastName(e.target.value)}
                className="text-sm"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Email Address</Label>
            <Input
              type="email"
              placeholder="jane@company.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              className="text-sm"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Role</Label>
            <Select value={inviteRole} onValueChange={setInviteRole}>
              <SelectTrigger className="text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="broker">Broker</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button
            size="sm"
            className="text-xs w-full"
            onClick={handleSendInvite}
            disabled={sending || !inviteEmail}
          >
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : (
              <Mail className="h-3.5 w-3.5 mr-1.5" />
            )}
            Send Invitation
          </Button>

          {lastInviteUrl && (
            <div className="rounded-lg border border-border bg-muted/50 p-3">
              <p className="text-xs font-medium mb-1.5">Invite Link</p>
              <div className="flex gap-2">
                <Input
                  value={lastInviteUrl}
                  readOnly
                  className="text-xs font-mono bg-background"
                />
                <Button size="sm" variant="outline" onClick={copyInviteUrl}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pending Invites Card */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-sm text-card-foreground">Invitations</CardTitle>
          <CardDescription className="text-xs">Track sent invitations and their status.</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingInvites ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : invites.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">No invitations sent yet.</p>
          ) : (
            <div className="space-y-2">
              {invites.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
                >
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{inv.email}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColors[inv.display_status] || statusColors.pending}`}>
                        {inv.display_status}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="capitalize">{inv.role}</span>
                      <span>·</span>
                      <Clock className="h-3 w-3" />
                      <span>{new Date(inv.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
