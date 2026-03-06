"use client"

import { useState, useRef, useCallback } from "react"
import { FileText, Image, File, FileX, Upload, Download, X, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { useDocuments, uploadDocument } from "@/lib/api"
import { toast } from "sonner"

const DOC_TYPES = ["BOL", "POD", "Rate Confirmation", "Insurance", "Contract", "Invoice"] as const

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getDocIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() || ""
  if (ext === "pdf") return FileText
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return Image
  return File
}

function isImage(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() || ""
  return ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)
}

interface DocItem {
  id: string
  name: string
  type: string
  blobUrl: string
  uploadDate: string
  fileSize: number
  uploadedBy: string
}

interface DocumentVaultProps {
  loadId: string
}

export function DocumentVault({ loadId }: DocumentVaultProps) {
  const { data: rawDocs = [], mutate: revalidateDocs } = useDocuments({ relatedTo: loadId, relatedType: "Load" })
  const [uploadOpen, setUploadOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [docType, setDocType] = useState<string>("BOL")
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)

  const docs: DocItem[] = rawDocs.map((d: Record<string, unknown>) => ({
    id: d.id as string,
    name: d.name as string,
    type: (d.type || "BOL") as string,
    blobUrl: (d.blob_url || "") as string,
    uploadDate: (d.upload_date || d.created_at || "") as string,
    fileSize: Number(d.file_size) || 0,
    uploadedBy: (d.uploaded_by || "") as string,
  }))

  const handleUpload = useCallback(async () => {
    if (!selectedFile) return
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append("file", selectedFile)
      formData.append("type", docType)
      formData.append("relatedTo", loadId)
      formData.append("relatedType", "Load")
      await uploadDocument(formData)
      revalidateDocs()
      toast.success(`${selectedFile.name} uploaded`)
      setUploadOpen(false)
      setSelectedFile(null)
      setDocType("BOL")
    } catch {
      toast.error("Upload failed")
    } finally {
      setUploading(false)
    }
  }, [selectedFile, docType, loadId, revalidateDocs])

  const handleDelete = useCallback(async () => {
    if (!deleteId) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/documents/${deleteId}`, { method: "DELETE" })
      if (!res.ok) throw new Error()
      revalidateDocs()
      toast.success("Document deleted")
    } catch {
      toast.error("Delete failed")
    } finally {
      setDeleting(false)
      setDeleteId(null)
    }
  }, [deleteId, revalidateDocs])

  const handleDownloadAll = useCallback(() => {
    window.open(`/api/documents/download-all?loadId=${loadId}`, "_blank")
  }, [loadId])

  const handleCardClick = useCallback((doc: DocItem) => {
    if (!doc.blobUrl) return
    if (doc.name.endsWith(".pdf")) {
      window.open(doc.blobUrl, "_blank")
    } else if (isImage(doc.name)) {
      setPreviewUrl(doc.blobUrl)
    } else {
      const a = document.createElement("a")
      a.href = doc.blobUrl
      a.download = doc.name
      a.click()
    }
  }, [])

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 10 * 1024 * 1024) {
      toast.error("File must be under 10MB")
      return
    }
    setSelectedFile(file)
  }, [])

  return (
    <div className="space-y-4">
      {/* Top Bar */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Documents</h3>
        <div className="flex items-center gap-2">
          {docs.length > 0 && (
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={handleDownloadAll}>
              <Download className="h-3 w-3" />
              Download All
            </Button>
          )}
          <Button size="sm" className="h-7 text-xs gap-1.5" onClick={() => setUploadOpen(true)}>
            <Upload className="h-3 w-3" />
            Upload Document
          </Button>
        </div>
      </div>

      {/* Document Grid */}
      {docs.length > 0 ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {docs.map((doc) => {
            const Icon = getDocIcon(doc.name)
            return (
              <Card
                key={doc.id}
                className="border-border bg-card hover:bg-secondary/30 transition-colors cursor-pointer group relative"
                onClick={() => handleCardClick(doc)}
              >
                <CardContent className="p-3">
                  <div className="flex items-start gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary shrink-0">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">{doc.name}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{doc.type}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-muted-foreground">
                          {doc.uploadDate ? new Date(doc.uploadDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "--"}
                        </span>
                        <span className="text-[10px] text-muted-foreground">{formatFileSize(doc.fileSize)}</span>
                      </div>
                      {doc.uploadedBy && (
                        <p className="text-[10px] text-muted-foreground/70 mt-0.5 truncate">{doc.uploadedBy}</p>
                      )}
                    </div>
                  </div>
                  <button
                    className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md hover:bg-destructive/10"
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleteId(doc.id)
                    }}
                  >
                    <X className="h-3 w-3 text-destructive" />
                  </button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <FileX className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No documents yet</p>
          <p className="text-xs text-muted-foreground/60 mt-1">Upload BOLs, PODs, rate confirmations, and more</p>
        </div>
      )}

      {/* Upload Dialog */}
      <Dialog open={uploadOpen} onOpenChange={(open) => { setUploadOpen(open); if (!open) { setSelectedFile(null); setDocType("BOL") } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Upload Document</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">File</Label>
              <div
                className="rounded-lg border-2 border-dashed border-border p-4 text-center cursor-pointer hover:border-accent/30 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
                  onChange={handleFileSelect}
                />
                {selectedFile ? (
                  <p className="text-xs text-foreground">{selectedFile.name} ({formatFileSize(selectedFile.size)})</p>
                ) : (
                  <p className="text-xs text-muted-foreground">Click to select a file (max 10MB)</p>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Document Type</Label>
              <Select value={docType} onValueChange={setDocType}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOC_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="text-xs" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button size="sm" className="text-xs gap-1.5" onClick={handleUpload} disabled={!selectedFile || uploading}>
              {uploading && <Loader2 className="h-3 w-3 animate-spin" />}
              {uploading ? "Uploading..." : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Image Preview Dialog */}
      <Dialog open={!!previewUrl} onOpenChange={() => setPreviewUrl(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-base">Preview</DialogTitle>
          </DialogHeader>
          {previewUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt="Document preview" className="w-full rounded-md" />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => { if (!open) setDeleteId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Document</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the document and its file. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : null}
              {deleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
