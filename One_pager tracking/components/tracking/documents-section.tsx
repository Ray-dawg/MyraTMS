"use client"

import { FileText, FileCheck, Receipt, Download, FolderOpen } from "lucide-react"
import { Button } from "@/components/ui/button"

export interface TrackingDocument {
  id: string
  name: string
  type: string
  uploadDate: string | null
  blobUrl: string | null
  fileSize: number | null
}

interface DocumentsSectionProps {
  documents: TrackingDocument[]
}

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function formatUploadDate(dateStr: string | null): string {
  if (!dateStr) return ""
  try {
    return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  } catch {
    return dateStr
  }
}

function typeIcon(type: string) {
  switch (type) {
    case "BOL":
      return <FileText className="h-5 w-5 text-primary" />
    case "POD":
      return <FileCheck className="h-5 w-5 text-[var(--brand-success)]" />
    case "Invoice":
      return <Receipt className="h-5 w-5 text-amber-500" />
    default:
      return <FileText className="h-5 w-5 text-muted-foreground" />
  }
}

export function DocumentsSection({ documents }: DocumentsSectionProps) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden font-sans">
      <div className="border-b border-border/60 px-5 py-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Documents
        </h3>
      </div>

      {documents.length === 0 ? (
        <div className="p-5">
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-secondary/30 py-10 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-secondary">
              <FolderOpen className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">No documents available yet</p>
              <p className="mt-1.5 max-w-[260px] text-[11px] text-muted-foreground leading-relaxed">
                Documents such as BOL, POD, and invoices will appear here when uploaded.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-border/60">
          {documents.map((doc) => (
            <div key={doc.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary/60">
                  {typeIcon(doc.type)}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{doc.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {doc.type}
                    {formatUploadDate(doc.uploadDate) && (
                      <> &middot; {formatUploadDate(doc.uploadDate)}</>
                    )}
                    {formatFileSize(doc.fileSize) && (
                      <> &middot; {formatFileSize(doc.fileSize)}</>
                    )}
                  </p>
                </div>
              </div>
              {doc.blobUrl && (
                <a href={doc.blobUrl} target="_blank" rel="noopener noreferrer" download>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 gap-1.5"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Download</span>
                  </Button>
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
