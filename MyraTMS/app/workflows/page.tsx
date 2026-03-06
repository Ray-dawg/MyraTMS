"use client"

import { useState, useCallback } from "react"
import { Plus, Play, Pause, Trash2, ClipboardList, Zap, Clock, CheckCircle, AlertTriangle, ArrowRight, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { useWorkflows, createWorkflow, updateWorkflow, deleteWorkflow as deleteWorkflowApi } from "@/lib/api"

interface Workflow {
  id: string
  name: string
  description: string
  trigger_type: string
  trigger_config: string | null
  conditions: string
  actions: string
  active: boolean
  last_run: string | null
  runs_today: number
  created_by: string
  created_at: string
  updated_at: string
}

const triggerOptions = [
  "Load status change",
  "AI Risk Alert generated",
  "Document uploaded",
  "New Shipper added",
  "New Carrier added",
  "Invoice overdue (>15 days)",
  "Insurance expiry < 30 days",
  "Margin below target",
  "Custom schedule (daily)",
  "Custom schedule (weekly)",
]

const actionOptions = [
  "Send Email Notification",
  "Notify Assigned Rep",
  "Notify Ops Manager",
  "Generate Invoice",
  "Flag Load/Carrier",
  "Update Dashboard",
  "Create Task",
  "Send External Email",
  "Log to Activity Feed",
  "Export Report",
]

function parseJsonSafe(val: string | string[] | null | undefined): string[] {
  if (!val) return []
  if (Array.isArray(val)) return val
  try { return JSON.parse(val) } catch { return [] }
}

export default function WorkflowsPage() {
  const { data: rawWorkflows, isLoading, error } = useWorkflows()
  const workflows: Workflow[] = rawWorkflows || []

  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ name: "", description: "", trigger: "", actions: [] as string[] })
  const [actionToAdd, setActionToAdd] = useState("")
  const [saving, setSaving] = useState(false)

  const activeCount = workflows.filter((w) => w.active).length
  const totalRuns = workflows.reduce((sum, w) => sum + (w.runs_today || 0), 0)

  const toggleWorkflow = useCallback(async (id: string) => {
    const wf = workflows.find((w) => w.id === id)
    if (!wf) return
    try {
      await updateWorkflow(id, { active: !wf.active })
      toast.success(`${wf.name} ${!wf.active ? "activated" : "paused"}`)
    } catch {
      toast.error("Failed to toggle workflow")
    }
  }, [workflows])

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteWorkflowApi(id)
      toast.success("Workflow deleted")
    } catch {
      toast.error("Failed to delete workflow")
    }
  }, [])

  const addAction = useCallback(() => {
    if (actionToAdd && !form.actions.includes(actionToAdd)) {
      setForm((p) => ({ ...p, actions: [...p.actions, actionToAdd] }))
      setActionToAdd("")
    }
  }, [actionToAdd, form.actions])

  const removeAction = (action: string) => {
    setForm((p) => ({ ...p, actions: p.actions.filter((a) => a !== action) }))
  }

  const handleCreate = useCallback(async () => {
    setSaving(true)
    try {
      await createWorkflow({
        name: form.name,
        description: form.description,
        triggerType: form.trigger,
        actions: form.actions,
        active: true,
      })
      toast.success(`Workflow "${form.name}" created`)
      setCreateOpen(false)
      setForm({ name: "", description: "", trigger: "", actions: [] })
    } catch {
      toast.error("Failed to create workflow")
    } finally {
      setSaving(false)
    }
  }, [form])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-muted-foreground">
        Failed to load workflows. Please try again.
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2"><ClipboardList className="h-5 w-5 text-muted-foreground" /><h1 className="text-xl font-semibold tracking-tight text-foreground">Workflows</h1></div>
          <p className="text-sm text-muted-foreground mt-0.5">Automate repetitive tasks across your brokerage operations</p>
        </div>
        <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => setCreateOpen(true)}><Plus className="h-3.5 w-3.5" />New Workflow</Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="border-border bg-card"><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><Zap className="h-3.5 w-3.5 text-accent" /><p className="text-[11px] text-muted-foreground">Total Workflows</p></div><p className="text-2xl font-semibold text-card-foreground">{workflows.length}</p></CardContent></Card>
        <Card className="border-border bg-card"><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><CheckCircle className="h-3.5 w-3.5 text-success" /><p className="text-[11px] text-muted-foreground">Active</p></div><p className="text-2xl font-semibold text-success">{activeCount}</p></CardContent></Card>
        <Card className="border-border bg-card"><CardContent className="p-4"><div className="flex items-center gap-2 mb-2"><Clock className="h-3.5 w-3.5 text-muted-foreground" /><p className="text-[11px] text-muted-foreground">Runs Today</p></div><p className="text-2xl font-semibold text-card-foreground">{totalRuns}</p></CardContent></Card>
      </div>

      {workflows.length === 0 ? (
        <div className="text-center py-12">
          <ClipboardList className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No workflows yet. Create your first workflow to automate operations.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {workflows.map((wf) => {
            const actions = parseJsonSafe(wf.actions)
            return (
              <Card key={wf.id} className={cn("border-border bg-card transition-colors", !wf.active && "opacity-60")}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-sm font-medium text-card-foreground">{wf.name}</h3>
                        <Badge variant={wf.active ? "default" : "secondary"} className="text-[9px]">{wf.active ? "Active" : "Paused"}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mb-3">{wf.description}</p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-[10px] gap-1"><AlertTriangle className="h-2.5 w-2.5" />Trigger: {wf.trigger_type}</Badge>
                        <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        {actions.map((action: string) => (
                          <Badge key={action} variant="secondary" className="text-[10px]">{action}</Badge>
                        ))}
                      </div>
                      <div className="flex items-center gap-4 mt-2">
                        <span className="text-[10px] text-muted-foreground">
                          Last run: {wf.last_run ? new Date(wf.last_run).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Never"}
                        </span>
                        <span className="text-[10px] text-muted-foreground">{wf.runs_today || 0} runs today</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      <Switch checked={wf.active} onCheckedChange={() => toggleWorkflow(wf.id)} />
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => handleDelete(wf.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="text-base">Create Workflow</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5"><Label className="text-xs">Workflow Name</Label><Input placeholder="e.g., Auto-Invoice on Delivery" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="h-9 text-sm" /></div>
            <div className="space-y-1.5"><Label className="text-xs">Description</Label><Textarea placeholder="What does this workflow do?" value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} className="text-sm min-h-[60px]" /></div>
            <div className="space-y-1.5">
              <Label className="text-xs">Trigger</Label>
              <Select value={form.trigger} onValueChange={(v) => setForm((p) => ({ ...p, trigger: v }))}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="Select trigger..." /></SelectTrigger>
                <SelectContent>{triggerOptions.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Actions</Label>
              <div className="flex gap-2">
                <Select value={actionToAdd} onValueChange={setActionToAdd}>
                  <SelectTrigger className="h-9 text-sm flex-1"><SelectValue placeholder="Add action..." /></SelectTrigger>
                  <SelectContent>{actionOptions.filter((a) => !form.actions.includes(a)).map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent>
                </Select>
                <Button size="sm" className="h-9 text-xs" onClick={addAction} disabled={!actionToAdd}>Add</Button>
              </div>
              {form.actions.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {form.actions.map((action) => (
                    <Badge key={action} variant="secondary" className="text-[10px] gap-1 cursor-pointer hover:bg-destructive/20" onClick={() => removeAction(action)}>
                      {action} &times;
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button size="sm" className="text-xs" onClick={handleCreate} disabled={!form.name || !form.trigger || form.actions.length === 0 || saving}>
              {saving && <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />}
              Create Workflow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
