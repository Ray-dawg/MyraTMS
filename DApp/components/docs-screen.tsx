'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  FileText,
  Download,
  Loader2,
  FolderOpen,
  Upload,
  Camera,
  X,
  CheckCircle2,
  Image as ImageIcon,
  File,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { driverFetch } from '@/lib/driver-fetch'
import { hapticLight, hapticSuccess, hapticError } from '@/lib/haptics'

interface DocItem {
  id: string
  name: string
  type: string
  related_to: string
  related_type: string
  upload_date: string
  status: string
  blob_url: string
  file_size: number
}

type DocFilter = 'all' | 'BOL' | 'POD' | 'Other'

const filterTabs: { id: DocFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'BOL', label: 'BOL' },
  { id: 'POD', label: 'POD' },
  { id: 'Other', label: 'Other' },
]

const typeColors: Record<string, string> = {
  'BOL': 'bg-info text-info-foreground',
  'POD': 'bg-success text-success-foreground',
  'Rate Confirmation': 'bg-warning text-warning-foreground',
  'Insurance': 'bg-accent text-accent-foreground',
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'].includes(ext || '')) return ImageIcon
  return File
}

export function DocsScreen() {
  const [docs, setDocs] = useState<DocItem[]>([])
  const [filter, setFilter] = useState<DocFilter>('all')
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [previewFiles, setPreviewFiles] = useState<{ file: File; preview: string }[]>([])
  const [docType, setDocType] = useState<string>('BOL')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  const fetchDocs = useCallback(async () => {
    setLoading(true)
    try {
      const res = await driverFetch('/api/documents?relatedType=Load')
      if (res.ok) {
        const data = await res.json()
        setDocs(Array.isArray(data) ? data : data.documents || [])
      }
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchDocs() }, [fetchDocs])

  // Cleanup preview URLs
  useEffect(() => {
    return () => {
      previewFiles.forEach((pf) => URL.revokeObjectURL(pf.preview))
    }
  }, [previewFiles])

  const handleFiles = useCallback((files: FileList | File[]) => {
    hapticLight()
    const fileArray = Array.from(files)
    const previews = fileArray.map((file) => ({
      file,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
    }))
    setPreviewFiles((prev) => [...prev, ...previews])
  }, [])

  const removePreview = useCallback((index: number) => {
    hapticLight()
    setPreviewFiles((prev) => {
      const removed = prev[index]
      if (removed.preview) URL.revokeObjectURL(removed.preview)
      return prev.filter((_, i) => i !== index)
    })
  }, [])

  const uploadFiles = useCallback(async () => {
    if (previewFiles.length === 0) return
    setUploading(true)
    hapticLight()

    let successCount = 0
    for (const { file } of previewFiles) {
      setUploadProgress(`Uploading ${file.name}...`)
      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('type', docType)
        formData.append('relatedType', 'Load')

        const res = await driverFetch('/api/documents', {
          method: 'POST',
          body: formData,
        })
        if (res.ok) successCount++
      } catch { /* continue */ }
    }

    if (successCount > 0) {
      hapticSuccess()
      setUploadProgress(`${successCount} file${successCount > 1 ? 's' : ''} uploaded!`)
      fetchDocs()
    } else {
      hapticError()
      setUploadProgress('Upload failed — check connection')
    }

    setPreviewFiles([])
    setUploading(false)
    setTimeout(() => setUploadProgress(null), 2500)
  }, [previewFiles, docType, fetchDocs])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files)
    }
  }, [handleFiles])

  const filtered = filter === 'all'
    ? docs
    : filter === 'Other'
      ? docs.filter((d) => !['BOL', 'POD'].includes(d.type))
      : docs.filter((d) => d.type === filter)

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/10 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-card/90 px-12 py-10">
            <Upload className="size-12 text-primary animate-bounce" />
            <p className="text-lg font-semibold text-foreground">Drop files here</p>
            <p className="text-sm text-muted-foreground">BOL, POD, photos, documents</p>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="safe-top border-b border-border bg-card px-4 pb-3 pt-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-foreground">Documents</h1>
            <p className="text-xs text-muted-foreground">{docs.length} document{docs.length !== 1 ? 's' : ''}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { hapticLight(); cameraInputRef.current?.click() }}
              className="flex size-9 items-center justify-center rounded-full bg-secondary text-foreground transition-all active:scale-90"
              aria-label="Take photo"
            >
              <Camera className="size-4" />
            </button>
            <button
              onClick={() => { hapticLight(); fileInputRef.current?.click() }}
              className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground transition-all active:scale-90"
              aria-label="Upload file"
            >
              <Upload className="size-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.pdf,.doc,.docx"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && handleFiles(e.target.files)}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => e.target.files && handleFiles(e.target.files)}
      />

      {/* Upload preview area */}
      {previewFiles.length > 0 && (
        <div className="border-b border-border bg-card px-4 py-3 animate-in slide-in-from-top-2 duration-300">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold text-foreground">
              {previewFiles.length} file{previewFiles.length > 1 ? 's' : ''} ready
            </p>
            <div className="flex items-center gap-2">
              <select
                value={docType}
                onChange={(e) => setDocType(e.target.value)}
                className="rounded-md bg-secondary px-2 py-1 text-[11px] font-medium text-foreground outline-none"
              >
                <option value="BOL">BOL</option>
                <option value="POD">POD</option>
                <option value="Rate Confirmation">Rate Con</option>
                <option value="Insurance">Insurance</option>
                <option value="Other">Other</option>
              </select>
            </div>
          </div>

          {/* Preview thumbnails */}
          <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
            {previewFiles.map((pf, i) => (
              <div key={i} className="relative shrink-0">
                {pf.preview ? (
                  <img
                    src={pf.preview}
                    alt={pf.file.name}
                    className="size-16 rounded-lg object-cover border border-border"
                  />
                ) : (
                  <div className="flex size-16 items-center justify-center rounded-lg border border-border bg-secondary">
                    <File className="size-6 text-muted-foreground" />
                  </div>
                )}
                <button
                  onClick={() => removePreview(i)}
                  className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-md"
                  aria-label="Remove file"
                >
                  <X className="size-3" />
                </button>
                <p className="mt-0.5 w-16 truncate text-center text-[8px] text-muted-foreground">
                  {pf.file.name}
                </p>
              </div>
            ))}
          </div>

          {/* Upload button */}
          <button
            onClick={uploadFiles}
            disabled={uploading}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-all active:scale-[0.98] disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {uploading ? 'Uploading...' : `Upload ${previewFiles.length} File${previewFiles.length > 1 ? 's' : ''}`}
          </button>
        </div>
      )}

      {/* Upload progress toast */}
      {uploadProgress && previewFiles.length === 0 && (
        <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg bg-success/10 border border-success/20 px-3 py-2 animate-in fade-in slide-in-from-top-2 duration-300">
          <CheckCircle2 className="size-4 text-success shrink-0" />
          <p className="text-xs font-medium text-foreground">{uploadProgress}</p>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-1.5 border-b border-border bg-card px-4 py-2">
        {filterTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => { hapticLight(); setFilter(tab.id) }}
            className={cn(
              'rounded-full px-3 py-1 text-[11px] font-medium transition-all active:scale-95',
              filter === tab.id
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Document list */}
      <div className="no-scrollbar flex-1 overflow-y-auto pb-24">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center px-6">
            <div
              onClick={() => { hapticLight(); fileInputRef.current?.click() }}
              className="mb-4 flex size-20 cursor-pointer items-center justify-center rounded-2xl border-2 border-dashed border-border transition-all hover:border-primary hover:bg-primary/5 active:scale-95"
            >
              <Upload className="size-8 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">
              {filter === 'all' ? 'No documents yet' : `No ${filter} documents`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Tap to upload or drag & drop files here
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((doc) => {
              const FileIcon = getFileIcon(doc.name)
              return (
                <a
                  key={doc.id}
                  href={doc.blob_url || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/50 active:bg-secondary"
                >
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary">
                    <FileIcon className="size-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{doc.name}</p>
                    <div className="mt-0.5 flex items-center gap-2">
                      <Badge className={cn('text-[9px] px-1.5 py-0', typeColors[doc.type] || 'bg-muted text-muted-foreground')}>
                        {doc.type}
                      </Badge>
                      {doc.related_to && (
                        <span className="font-mono text-[10px] text-muted-foreground">{doc.related_to}</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span>{formatDate(doc.upload_date)}</span>
                      {doc.file_size > 0 && <span>{formatSize(doc.file_size)}</span>}
                    </div>
                  </div>
                  {doc.blob_url && <Download className="size-4 shrink-0 text-muted-foreground" />}
                </a>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
