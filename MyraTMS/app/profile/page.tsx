"use client"

import { useState, useEffect } from "react"
import { UserCircle, Shield, Bell, Clock, Save, Loader2 } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { useWorkspace } from "@/lib/workspace-context"
import { toast } from "sonner"

// -------------------------------------------------------------------
// Notification settings keys & defaults (same keys as settings page)
// -------------------------------------------------------------------
const NOTIFICATION_ITEMS = [
  { key: "notif_ai_risk_alerts", label: "AI Risk Alerts", description: "Get notified when AI flags at-risk loads or carriers", defaultValue: true },
  { key: "notif_load_status_updates", label: "Load Status Updates", description: "Notifications for pickup, delivery, and status changes", defaultValue: true },
  { key: "notif_invoice_reminders", label: "Invoice Reminders", description: "Alerts for overdue invoices and payment confirmations", defaultValue: true },
  { key: "notif_document_uploads", label: "Document Uploads", description: "Notify when BOLs, PODs, or rate confirmations are uploaded", defaultValue: false },
  { key: "notif_weekly_digest", label: "Weekly Digest", description: "Summary every Monday", defaultValue: true },
]

export default function ProfilePage() {
  const { profile, updateProfile, profileLoading } = useWorkspace()

  // Local profile state — synced from workspace context on mount / change
  const [local, setLocal] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    role: "admin" as "admin" | "ops" | "sales",
  })
  const [passwords, setPasswords] = useState({ current: "", new: "", confirm: "" })
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const [savingPrefs, setSavingPrefs] = useState(false)

  // Notification preferences (fetched from /api/settings)
  const [notifSettings, setNotifSettings] = useState<Record<string, boolean>>(() => {
    const defaults: Record<string, boolean> = {}
    NOTIFICATION_ITEMS.forEach((item) => { defaults[item.key] = item.defaultValue })
    return defaults
  })

  // Sync profile from context when it loads
  useEffect(() => {
    if (profile.firstName) {
      setLocal({
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: profile.email,
        phone: profile.phone,
        role: profile.role,
      })
    }
  }, [profile])

  // Fetch notification preferences from settings API
  useEffect(() => {
    async function fetchNotifSettings() {
      try {
        const res = await fetch("/api/settings")
        if (!res.ok) return
        const data = await res.json()
        const s = data.settings || {}
        setNotifSettings((prev) => {
          const next = { ...prev }
          for (const key of Object.keys(prev)) {
            if (s[key] !== undefined) next[key] = s[key]
          }
          return next
        })
      } catch {
        // Keep defaults
      }
    }
    fetchNotifSettings()
  }, [])

  const handleSaveProfile = async () => {
    // Only send changed fields
    const body: Record<string, string> = {}
    if (local.firstName !== profile.firstName) body.firstName = local.firstName
    if (local.lastName !== profile.lastName) body.lastName = local.lastName
    if (local.phone !== profile.phone) body.phone = local.phone

    // If nothing changed, skip the API call
    if (Object.keys(body).length === 0) {
      toast.info("No changes to save")
      return
    }

    setSavingProfile(true)
    try {
      const res = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to update profile")
      }

      // Update workspace context with new values
      updateProfile({
        firstName: local.firstName,
        lastName: local.lastName,
        phone: local.phone,
      })

      toast.success("Profile updated successfully")
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update profile"
      toast.error(message)
    } finally {
      setSavingProfile(false)
    }
  }

  const handleSavePassword = async () => {
    if (passwords.new !== passwords.confirm) {
      toast.error("Passwords do not match")
      return
    }
    if (passwords.new.length < 8) {
      toast.error("Password must be at least 8 characters")
      return
    }
    setSavingPassword(true)
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
      setSavingPassword(false)
    }
  }

  const handleSavePreferences = async () => {
    setSavingPrefs(true)
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: notifSettings }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || "Failed to save preferences")
      }
      toast.success("Notification preferences saved")
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to save preferences"
      toast.error(message)
    } finally {
      setSavingPrefs(false)
    }
  }

  // Derive initials from local state
  const initials = `${(local.firstName || "U")[0]}${(local.lastName || "")[0] || ""}`.toUpperCase()

  if (profileLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading profile...</span>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Avatar className="h-16 w-16">
          <AvatarFallback className="bg-accent text-accent-foreground text-xl">{initials}</AvatarFallback>
        </Avatar>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{local.firstName} {local.lastName}</h1>
          <p className="text-sm text-muted-foreground capitalize">{local.role} &middot; Myra Freight Brokerage</p>
        </div>
      </div>

      <Tabs defaultValue="personal" className="space-y-4">
        <TabsList className="bg-secondary/50">
          <TabsTrigger value="personal" className="gap-1.5 text-xs"><UserCircle className="h-3.5 w-3.5" />Personal Info</TabsTrigger>
          <TabsTrigger value="security" className="gap-1.5 text-xs"><Shield className="h-3.5 w-3.5" />Security</TabsTrigger>
          <TabsTrigger value="preferences" className="gap-1.5 text-xs"><Bell className="h-3.5 w-3.5" />Preferences</TabsTrigger>
          <TabsTrigger value="activity" className="gap-1.5 text-xs"><Clock className="h-3.5 w-3.5" />Activity Log</TabsTrigger>
        </TabsList>

        <TabsContent value="personal">
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
                    value={local.firstName}
                    onChange={(e) => setLocal((p) => ({ ...p, firstName: e.target.value }))}
                    className="h-9 text-sm"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Last Name</Label>
                  <Input
                    value={local.lastName}
                    onChange={(e) => setLocal((p) => ({ ...p, lastName: e.target.value }))}
                    className="h-9 text-sm"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Email</Label>
                <Input
                  value={local.email}
                  disabled
                  className="h-9 text-sm opacity-60"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Phone</Label>
                <Input
                  value={local.phone}
                  onChange={(e) => setLocal((p) => ({ ...p, phone: e.target.value }))}
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Role</Label>
                <Select value={local.role} disabled>
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
                  className="text-xs gap-1.5"
                  onClick={handleSaveProfile}
                  disabled={savingProfile}
                >
                  {savingProfile ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  Save Changes
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="security">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-sm text-card-foreground">Change Password</CardTitle>
              <CardDescription className="text-xs">Keep your account secure with a strong password.</CardDescription>
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
                  <p className="text-xs text-muted-foreground">Add an extra layer of security</p>
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
                  onClick={handleSavePassword}
                  disabled={!passwords.current || !passwords.new || savingPassword}
                >
                  {savingPassword && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                  Update Password
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="preferences">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-sm text-card-foreground">Notification Preferences</CardTitle>
              <CardDescription className="text-xs">Choose what alerts you receive.</CardDescription>
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
                  onClick={handleSavePreferences}
                  disabled={savingPrefs}
                >
                  {savingPrefs && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                  Save Preferences
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activity">
          <Card className="border-border bg-card">
            <CardHeader>
              <CardTitle className="text-sm text-card-foreground">Recent Activity</CardTitle>
              <CardDescription className="text-xs">Your recent actions in the system.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {[
                  { action: "Created load LD-4829", time: "Today at 8:45 AM" },
                  { action: "Updated shipper Apex Manufacturing", time: "Today at 8:30 AM" },
                  { action: "Exported finance report", time: "Yesterday at 4:15 PM" },
                  { action: "Uploaded BOL for LD-4821", time: "Yesterday at 2:00 PM" },
                  { action: "Assigned carrier to LD-4823", time: "Feb 14 at 11:30 AM" },
                  { action: "Changed password", time: "Feb 12 at 9:00 AM" },
                  { action: "Created custom margin report", time: "Feb 11 at 3:45 PM" },
                  { action: "Added carrier Cascade Freight", time: "Feb 10 at 10:15 AM" },
                ].map((item, i) => (
                  <div key={i} className="flex items-center justify-between py-2 border-b border-border last:border-b-0">
                    <p className="text-xs text-foreground">{item.action}</p>
                    <p className="text-[11px] text-muted-foreground">{item.time}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
