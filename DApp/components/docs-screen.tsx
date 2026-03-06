'use client'

import { useState, useEffect, useCallback } from 'react'
import { FileText, Download, Filter, Loader2, FolderOpen } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { driverFetch } from '@/lib/driver-fetch'

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

export function DocsScreen() {
  const [docs, setDocs] = useState<DocItem[]>([])
  const [filter, setFilter] = useState<DocFilter>('all')
  const [loading, setLoading] = useState(true)

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

  const filtered = filter === 'all'
    ? docs
    : filter === 'Other'
      ? docs.filter((d) => !['BOL', 'POD'].includes(d.type))
      : docs.filter((d) => d.type === filter)

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="safe-top border-b border-border bg-card px-4 pb-3 pt-3">
        <h1 className="text-lg font-bold text-foreground">Documents</h1>
        <p className="text-xs text-muted-foreground">{docs.length} document{docs.length !== 1 ? 's' : ''}</p>
      </header>

      {/* Filter tabs */}
      <div className="flex gap-1.5 border-b border-border bg-card px-4 py-2">
        {filterTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setFilter(tab.id)}
            className={`rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
              filter === tab.id
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary text-muted-foreground hover:text-foreground'
            }`}
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
          <div className="flex flex-col items-center justify-center py-20 text-center px-6">
            <FolderOpen className="mb-3 size-12 text-muted-foreground/40" />
            <p className="text-sm font-medium text-foreground">No documents</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {filter === 'all' ? 'No documents uploaded yet' : `No ${filter} documents found`}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((doc) => (
              <a
                key={doc.id}
                href={doc.blob_url || '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/50 active:bg-secondary"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary">
                  <FileText className="size-5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{doc.name}</p>
                  <div className="mt-0.5 flex items-center gap-2">
                    <Badge className={`text-[9px] px-1.5 py-0 ${typeColors[doc.type] || 'bg-muted text-muted-foreground'}`}>
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
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
