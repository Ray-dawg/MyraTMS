"use client"

import { useState } from "react"
import { Phone, Mail, Video, MapPin, MessageSquare, Plus, Sparkles, Clock, FileText, ArrowDownUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

export type NoteType = "phone_call" | "email" | "zoom_meeting" | "field_visit" | "internal_note"

export interface ActivityNote {
  id: string
  type: NoteType
  title: string
  content: string
  timestamp: string
  user: string
  duration?: string
  contactPerson?: string
}

const noteTypeConfig: Record<NoteType, { label: string; icon: typeof Phone; color: string }> = {
  phone_call: { label: "Phone Call", icon: Phone, color: "text-chart-4" },
  email: { label: "Email", icon: Mail, color: "text-chart-1" },
  zoom_meeting: { label: "Zoom Meeting", icon: Video, color: "text-accent" },
  field_visit: { label: "Field Visit", icon: MapPin, color: "text-success" },
  internal_note: { label: "Internal Note", icon: MessageSquare, color: "text-muted-foreground" },
}

function formatTimestamp(ts: string) {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function ActivityNotes({
  entityId,
  entityType,
  initialNotes = [],
}: {
  entityId: string
  entityType: "Load" | "Shipper" | "Carrier"
  initialNotes?: ActivityNote[]
}) {
  const [notes, setNotes] = useState<ActivityNote[]>(initialNotes)
  const [addOpen, setAddOpen] = useState(false)
  const [sortNewest, setSortNewest] = useState(true)
  const [form, setForm] = useState<{
    type: NoteType
    title: string
    content: string
    duration: string
    contactPerson: string
  }>({
    type: "phone_call",
    title: "",
    content: "",
    duration: "",
    contactPerson: "",
  })

  const sortedNotes = [...notes].sort((a, b) => {
    const diff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    return sortNewest ? diff : -diff
  })

  const handleAdd = () => {
    const note: ActivityNote = {
      id: `note-${Date.now()}`,
      type: form.type,
      title: form.title || noteTypeConfig[form.type].label,
      content: form.content,
      timestamp: new Date().toISOString(),
      user: "Sarah Chen",
      duration: form.duration || undefined,
      contactPerson: form.contactPerson || undefined,
    }
    setNotes((prev) => [note, ...prev])
    setAddOpen(false)
    setForm({ type: "phone_call", title: "", content: "", duration: "", contactPerson: "" })
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">
            Activity Notes
            {notes.length > 0 && (
              <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">({notes.length})</span>
            )}
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setSortNewest(!sortNewest)}
            >
              <ArrowDownUp className="h-3 w-3" />
              <span className="sr-only">Toggle sort</span>
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={() => setAddOpen(true)}>
              <Plus className="h-3 w-3" />
              Add Note
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {sortedNotes.length > 0 ? (
          <div className="space-y-0">
            {sortedNotes.map((note, i) => {
              const config = noteTypeConfig[note.type]
              const Icon = config.icon
              return (
                <div key={note.id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div className={cn("mt-0.5 p-1 rounded-md bg-secondary/50 shrink-0")}>
                      <Icon className={cn("h-3 w-3", config.color)} />
                    </div>
                    {i < sortedNotes.length - 1 && (
                      <div className="w-px flex-1 bg-border mt-1.5" />
                    )}
                  </div>
                  <div className="flex-1 pb-4 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-medium text-foreground">{note.title}</p>
                      <span className={cn("text-[9px] font-medium px-1.5 py-0.5 rounded-full", config.color, "bg-secondary/50")}>
                        {config.label}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed whitespace-pre-wrap">
                      {note.content}
                    </p>
                    <div className="flex items-center gap-3 mt-1.5">
                      <span className="text-[10px] text-muted-foreground/60">
                        {note.user} &middot; {formatTimestamp(note.timestamp)}
                      </span>
                      {note.duration && (
                        <span className="text-[10px] text-muted-foreground/60 flex items-center gap-0.5">
                          <Clock className="h-2.5 w-2.5" />{note.duration}
                        </span>
                      )}
                      {note.contactPerson && (
                        <span className="text-[10px] text-muted-foreground/60">
                          with {note.contactPerson}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <FileText className="h-8 w-8 text-muted-foreground/30 mb-2" />
            <p className="text-xs text-muted-foreground">No activity notes yet.</p>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">
              Record calls, emails, meetings, and visits for this {entityType.toLowerCase()}.
            </p>
          </div>
        )}
      </CardContent>

      {/* Add Note Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Add Activity Note</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Type</Label>
              <Select value={form.type} onValueChange={(v) => setForm((p) => ({ ...p, type: v as NoteType }))}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(noteTypeConfig).map(([key, cfg]) => {
                    const Icon = cfg.icon
                    return (
                      <SelectItem key={key} value={key}>
                        <div className="flex items-center gap-2">
                          <Icon className={cn("h-3.5 w-3.5", cfg.color)} />
                          {cfg.label}
                        </div>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Title</Label>
              <Input
                placeholder={`e.g., Follow-up ${noteTypeConfig[form.type].label.toLowerCase()}`}
                value={form.title}
                onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                className="h-9 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Contact Person</Label>
                <Input
                  placeholder="Name"
                  value={form.contactPerson}
                  onChange={(e) => setForm((p) => ({ ...p, contactPerson: e.target.value }))}
                  className="h-9 text-sm"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Duration</Label>
                <Input
                  placeholder="e.g., 15 min"
                  value={form.duration}
                  onChange={(e) => setForm((p) => ({ ...p, duration: e.target.value }))}
                  className="h-9 text-sm"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Notes</Label>
              <Textarea
                placeholder="What was discussed? Any action items?"
                value={form.content}
                onChange={(e) => setForm((p) => ({ ...p, content: e.target.value }))}
                className="text-sm min-h-[100px] resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" className="text-xs" onClick={handleAdd} disabled={!form.content}>Save Note</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
