"use client"

import { useState, useCallback, useRef } from "react"
import { Search, Upload, FileText, Eye, Tag } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/status-badge"
import { toast } from "sonner"

type Document = {
  id: string
  name: string
  type: "BOL" | "POD" | "Rate Confirmation" | "Insurance" | "Contract" | "Invoice"
  relatedTo: string
  relatedType: "Load" | "Shipper" | "Carrier"
  uploadDate: string
  status: string
  uploadedBy: string
}
import { useWorkspace } from "@/lib/workspace-context"
import { useDocuments, uploadDocument } from "@/lib/api"

const docTypes = ["BOL", "POD", "Rate Confirmation", "Insurance", "Contract", "Invoice"] as const

export default function DocumentsPage() {
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [relatedFilter, setRelatedFilter] = useState<string>("all")
  const [uploadOpen, setUploadOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { addNotification } = useWorkspace()

  const { data: rawDocs = [], mutate: revalidateDocs } = useDocuments()

  const allDocs: Document[] = rawDocs.map((d: Record<string, unknown>) => ({
    id: d.id as string,
    name: d.name as string,
    type: (d.type || "BOL") as Document["type"],
    relatedTo: (d.related_to || "") as string,
    relatedType: (d.related_type || "Load") as Document["relatedType"],
    uploadDate: (d.upload_date || "") as string,
    status: (d.status || "Pending Review") as string,
    uploadedBy: (d.uploaded_by || "") as string,
  }))

  const [form, setForm] = useState({ name: "", type: "BOL" as Document["type"], relatedTo: "", relatedType: "Load" as Document["relatedType"] })

  const filtered = allDocs.filter((d) => {
    const matchesSearch = !search || d.name.toLowerCase().includes(search.toLowerCase()) || d.relatedTo.toLowerCase().includes(search.toLowerCase())
    const matchesType = typeFilter === "all" || d.type === typeFilter
    const matchesStatus = statusFilter === "all" || d.status === statusFilter
    const matchesRelated = relatedFilter === "all" || d.relatedType === relatedFilter
    return matchesSearch && matchesType && matchesStatus && matchesRelated
  })

  const missingCount = allDocs.filter((d) => d.status === "Missing").length
  const pendingCount = allDocs.filter((d) => d.status === "Pending Review").length

  const uploadFile = useCallback(async (file: File, docType?: string, relatedTo?: string, relatedType?: string) => {
    const formData = new FormData()
    formData.append("file", file)
    formData.append("type", docType || "BOL")
    formData.append("relatedTo", relatedTo || "")
    formData.append("relatedType", relatedType || "Load")
    try {
      await uploadDocument(formData)
      revalidateDocs()
      addNotification({ title: `Document uploaded: ${file.name}`, description: `${docType || "BOL"} uploaded`, type: "info", timestamp: new Date().toISOString() })
      toast.success(`${file.name} uploaded successfully`)
    } catch {
      toast.error(`Failed to upload ${file.name}`)
    }
  }, [addNotification, revalidateDocs])

  const handleUpload = useCallback(async () => {
    // For manual upload via dialog, create a minimal file from the name
    const file = new File([""], form.name || "document.pdf", { type: "application/pdf" })
    await uploadFile(file, form.type, form.relatedTo, form.relatedType)
    setUploadOpen(false)
    setForm({ name: "", type: "BOL", relatedTo: "", relatedType: "Load" })
  }, [form, uploadFile])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
    const files = Array.from(e.dataTransfer.files)
    for (const file of files) {
      await uploadFile(file)
    }
  }, [uploadFile])

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    for (const file of files) {
      await uploadFile(file)
    }
  }, [uploadFile])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Documents</h1>
          <p className="text-xs text-muted-foreground mt-0.5">{allDocs.length} documents &middot; {missingCount} missing &middot; {pendingCount} pending review</p>
        </div>
        <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => setUploadOpen(true)}><Upload className="h-3.5 w-3.5" />Upload Document</Button>
      </div>

      {/* Drop Zone */}
      <div
        className={`mx-6 mt-4 rounded-lg border-2 border-dashed p-6 text-center transition-colors cursor-pointer ${dragActive ? "border-accent bg-accent/5" : "border-border bg-secondary/20 hover:border-accent/30"}`}
        onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
        <Upload className="h-6 w-6 text-muted-foreground mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">{dragActive ? "Drop files here..." : "Drag & drop files here to upload, or click to browse"}</p>
        <p className="text-[10px] text-muted-foreground/60 mt-0.5">BOL, POD, Rate Confirmations, Insurance, Contracts</p>
      </div>

      <div className="grid grid-cols-4 gap-4 px-6 py-4">
        <Card className="border-border bg-card"><CardContent className="p-4"><p className="text-[11px] text-muted-foreground">Total Documents</p><p className="text-2xl font-semibold text-card-foreground mt-1">{allDocs.length}</p></CardContent></Card>
        <Card className="border-border bg-card"><CardContent className="p-4"><p className="text-[11px] text-muted-foreground">Complete</p><p className="text-2xl font-semibold text-success mt-1">{allDocs.filter((d) => d.status === "Complete").length}</p></CardContent></Card>
        <Card className="border-border bg-card"><CardContent className="p-4"><p className="text-[11px] text-muted-foreground">Missing</p><p className="text-2xl font-semibold text-destructive mt-1">{missingCount}</p></CardContent></Card>
        <Card className="border-border bg-card"><CardContent className="p-4"><p className="text-[11px] text-muted-foreground">Pending Review</p><p className="text-2xl font-semibold text-warning mt-1">{pendingCount}</p></CardContent></Card>
      </div>

      <div className="flex items-center gap-3 px-6 py-3 border-b border-border">
        <div className="relative flex-1 max-w-xs"><Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search documents..." className="h-8 pl-8 text-xs bg-secondary/30" /></div>
        <Select value={typeFilter} onValueChange={setTypeFilter}><SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="Type" /></SelectTrigger><SelectContent><SelectItem value="all">All Types</SelectItem>{docTypes.map((t) => (<SelectItem key={t} value={t}>{t}</SelectItem>))}</SelectContent></Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="Status" /></SelectTrigger><SelectContent><SelectItem value="all">All Statuses</SelectItem><SelectItem value="Complete">Complete</SelectItem><SelectItem value="Missing">Missing</SelectItem><SelectItem value="Pending Review">Pending Review</SelectItem></SelectContent></Select>
        <Select value={relatedFilter} onValueChange={setRelatedFilter}><SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="Related To" /></SelectTrigger><SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="Load">Loads</SelectItem><SelectItem value="Shipper">Shippers</SelectItem><SelectItem value="Carrier">Carriers</SelectItem></SelectContent></Select>
      </div>

      <div className="flex-1 overflow-auto scrollbar-thin">
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent"><TableHead className="text-xs">Document</TableHead><TableHead className="text-xs">Type</TableHead><TableHead className="text-xs">Related To</TableHead><TableHead className="text-xs">Upload Date</TableHead><TableHead className="text-xs">Status</TableHead><TableHead className="text-xs">Uploaded By</TableHead><TableHead className="text-xs w-20">Actions</TableHead></TableRow></TableHeader>
          <TableBody>
            {filtered.map((doc) => (
              <TableRow key={doc.id} className="hover:bg-secondary/30 transition-colors">
                <TableCell className="py-2.5"><div className="flex items-center gap-2"><div className="flex h-7 w-7 items-center justify-center rounded-md bg-secondary"><FileText className="h-3.5 w-3.5 text-muted-foreground" /></div><span className="text-xs font-medium text-foreground">{doc.name}</span></div></TableCell>
                <TableCell className="py-2.5"><Badge variant="secondary" className="text-[10px]">{doc.type}</Badge></TableCell>
                <TableCell className="py-2.5"><div className="flex items-center gap-1.5"><Tag className="h-3 w-3 text-muted-foreground" /><span className="text-xs text-muted-foreground">{doc.relatedTo}</span><Badge variant="outline" className="text-[9px] px-1.5">{doc.relatedType}</Badge></div></TableCell>
                <TableCell className="text-xs text-muted-foreground py-2.5">{new Date(doc.uploadDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</TableCell>
                <TableCell className="py-2.5"><StatusBadge status={doc.status} /></TableCell>
                <TableCell className="text-xs text-muted-foreground py-2.5">{doc.uploadedBy || "--"}</TableCell>
                <TableCell className="py-2.5"><Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => toast.info(`Preview: ${doc.name}`)}><Eye className="h-3.5 w-3.5" /><span className="sr-only">Preview document</span></Button></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="text-base">Upload Document</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5"><Label className="text-xs">Document Name</Label><Input placeholder="e.g., BOL-LD4833.pdf" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className="h-9 text-sm" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label className="text-xs">Type</Label><Select value={form.type} onValueChange={(v) => setForm((p) => ({ ...p, type: v as Document["type"] }))}><SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger><SelectContent>{docTypes.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1.5"><Label className="text-xs">Related Type</Label><Select value={form.relatedType} onValueChange={(v) => setForm((p) => ({ ...p, relatedType: v as Document["relatedType"] }))}><SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Load">Load</SelectItem><SelectItem value="Shipper">Shipper</SelectItem><SelectItem value="Carrier">Carrier</SelectItem></SelectContent></Select></div>
            </div>
            <div className="space-y-1.5"><Label className="text-xs">Related To (ID)</Label><Input placeholder="e.g., LD-4821 or SH-001" value={form.relatedTo} onChange={(e) => setForm((p) => ({ ...p, relatedTo: e.target.value }))} className="h-9 text-sm font-mono" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button size="sm" className="text-xs" onClick={handleUpload} disabled={!form.name}>Upload</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
