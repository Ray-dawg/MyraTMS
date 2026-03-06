'use client'

import { useState, useCallback, useRef } from 'react'
import {
  FileText,
  CheckCircle,
  DollarSign,
  Upload,
  Camera,
  Download,
  Trash2,
  X,
  Loader2,
} from 'lucide-react'
import { T } from '@/lib/driver-theme'
import { GlassPanel, Divider, Page } from '@/components/driver/shared'
import { SkeletonDocRow } from '@/components/driver/skeleton'

/* ── Types ── */
interface Doc {
  id: string
  name: string
  type: string
  size: string
  date: string
  load: string | null
}

/* ── Initial Data ── */
const INIT_DOCS: Doc[] = [
  { id: 'D-001', name: 'BOL-LD2024-001.pdf', type: 'BOL', size: '2.4 MB', date: 'Feb 27, 2026', load: 'LD-2024-001' },
  { id: 'D-002', name: 'POD-LD2024-001.jpg', type: 'POD', size: '1.8 MB', date: 'Feb 27, 2026', load: 'LD-2024-001' },
  { id: 'D-003', name: 'Fuel-Receipt-0227.pdf', type: 'Fuel', size: '340 KB', date: 'Feb 27, 2026', load: null },
  { id: 'D-004', name: 'BOL-LD2024-002.pdf', type: 'BOL', size: '2.1 MB', date: 'Feb 26, 2026', load: 'LD-2024-002' },
  { id: 'D-005', name: 'Insurance-2026.pdf', type: 'Other', size: '4.2 MB', date: 'Feb 20, 2026', load: null },
]

/* ── Helpers ── */
const UPLOAD_TYPES = [
  { label: 'BOL', subtitle: 'Bill of Lading', icon: FileText, color: T.blue, dim: T.blueDim },
  { label: 'POD', subtitle: 'Proof of Delivery', icon: CheckCircle, color: T.green, dim: T.greenDim },
  { label: 'Fuel', subtitle: 'Fuel Receipt', icon: DollarSign, color: T.amber, dim: T.amberDim },
  { label: 'Other', subtitle: 'Other', icon: Upload, color: T.purple, dim: T.purpleDim },
] as const

const FILTERS = ['All', 'BOL', 'POD', 'Fuel', 'Other'] as const

function docMeta(type: string) {
  switch (type) {
    case 'BOL':
      return { icon: FileText, color: T.blue, dim: T.blueDim }
    case 'POD':
      return { icon: CheckCircle, color: T.green, dim: T.greenDim }
    case 'Fuel':
      return { icon: DollarSign, color: T.amber, dim: T.amberDim }
    default:
      return { icon: FileText, color: T.purple, dim: T.purpleDim }
  }
}

/* ── Component ── */
export function DocsTab() {
  const [docs, setDocs] = useState<Doc[]>(INIT_DOCS)
  const [activeFilter, setActiveFilter] = useState<string>('All')
  const [uploadType, setUploadType] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [filterLoading, setFilterLoading] = useState(false)
  const counterRef = useRef(INIT_DOCS.length)

  const filteredDocs = activeFilter === 'All'
    ? docs
    : docs.filter((d) => d.type === activeFilter)

  const handleFilterChange = useCallback((f: string) => {
    if (f === activeFilter) return
    setFilterLoading(true)
    setActiveFilter(f)
    setTimeout(() => setFilterLoading(false), 200)
  }, [activeFilter])

  const handleUpload = useCallback(() => {
    if (!uploadType) return
    setUploading(true)
    setUploadProgress(0)

    const steps = 20
    let step = 0
    const interval = setInterval(() => {
      step++
      setUploadProgress(Math.min(Math.round((step / steps) * 100), 100))
      if (step >= steps) {
        clearInterval(interval)
        counterRef.current += 1
        const newId = `D-${String(counterRef.current).padStart(3, '0')}`
        const ext = uploadType === 'POD' ? 'jpg' : 'pdf'
        const newDoc: Doc = {
          id: newId,
          name: `${uploadType}-Upload-${newId}.${ext}`,
          type: uploadType,
          size: '1.2 MB',
          date: 'Feb 27, 2026',
          load: null,
        }
        setDocs((prev) => [newDoc, ...prev])
        setUploading(false)
        setUploadProgress(0)
        setUploadType(null)
      }
    }, 100)
  }, [uploadType])

  const handleDelete = useCallback(() => {
    if (!deleteId) return
    setDeleting(true)
    setTimeout(() => {
      setDocs((prev) => prev.filter((d) => d.id !== deleteId))
      setDeleteId(null)
      setDeleting(false)
    }, 400)
  }, [deleteId])

  return (
    <Page>
      <div style={{ padding: '16px 18px 32px' }}>

        {/* ── Header ── */}
        <p
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: T.textMuted,
            margin: 0,
            marginBottom: 4,
          }}
        >
          Documents
        </p>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 800,
            color: T.textPrimary,
            margin: 0,
            marginBottom: 20,
            lineHeight: 1.2,
          }}
        >
          Document Vault
        </h1>

        {/* ── Upload Grid ── */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
            marginBottom: 20,
          }}
        >
          {UPLOAD_TYPES.map((ut) => {
            const Icon = ut.icon
            return (
              <button
                key={ut.label}
                onClick={() => setUploadType(ut.label)}
                style={{
                  background: T.surface,
                  backdropFilter: 'blur(24px)',
                  WebkitBackdropFilter: 'blur(24px)',
                  border: `1px solid ${T.borderMuted}`,
                  borderRadius: 16,
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 14,
                    background: ut.dim,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon size={20} color={ut.color} />
                </div>
                <span style={{ fontSize: 12, fontWeight: 600, color: T.textPrimary }}>
                  {ut.label === 'Fuel' ? 'Fuel Receipt' : ut.label}
                </span>
                <span style={{ fontSize: 10, color: T.textMuted }}>Tap to upload</span>
              </button>
            )
          })}
        </div>

        {/* ── Filter Pills ── */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 16,
            overflowX: 'auto',
            scrollbarWidth: 'none',
          }}
        >
          {FILTERS.map((f) => {
            const isActive = activeFilter === f
            return (
              <button
                key={f}
                onClick={() => handleFilterChange(f)}
                style={{
                  padding: '6px 14px',
                  borderRadius: 10,
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.2s',
                  border: `1px solid ${isActive ? T.accent + '44' : 'rgba(255,255,255,.1)'}`,
                  background: isActive ? T.accentDim : 'rgba(255,255,255,.06)',
                  color: isActive ? T.accent : T.textMuted,
                }}
              >
                {f}
              </button>
            )
          })}
        </div>

        {/* ── Document List ── */}
        <GlassPanel style={{ overflow: 'hidden' }}>
          {filterLoading && (
            <div style={{ padding: '4px 16px' }}>
              {[1, 2, 3].map(i => <SkeletonDocRow key={i} />)}
            </div>
          )}
          {!filterLoading && filteredDocs.length === 0 && (
            <div
              style={{
                padding: '32px 16px',
                textAlign: 'center',
                color: T.textMuted,
                fontSize: 13,
              }}
            >
              No documents found
            </div>
          )}
          {!filterLoading && filteredDocs.map((doc, idx) => {
            const meta = docMeta(doc.type)
            const Icon = meta.icon
            return (
              <div key={doc.id}>
                <div
                  style={{
                    padding: '13px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  {/* Icon */}
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 11,
                      background: meta.dim,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Icon size={18} color={meta.color} />
                  </div>

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: T.textPrimary,
                        margin: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {doc.name}
                    </p>
                    <p
                      style={{
                        fontSize: 11,
                        color: T.textMuted,
                        margin: 0,
                        marginTop: 2,
                      }}
                    >
                      {doc.size} &middot; {doc.date}
                      {doc.load && (
                        <span style={{ color: T.accent }}> &middot; {doc.load}</span>
                      )}
                    </p>
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button
                      onClick={() => {/* download stub */}}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        background: 'rgba(255,255,255,.06)',
                        border: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                      }}
                    >
                      <Download size={14} color={T.textSecondary} />
                    </button>
                    <button
                      onClick={() => setDeleteId(doc.id)}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        background: T.redDim,
                        border: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                      }}
                    >
                      <Trash2 size={14} color={T.red} />
                    </button>
                  </div>
                </div>
                {idx < filteredDocs.length - 1 && <Divider />}
              </div>
            )
          })}
        </GlassPanel>
      </div>

      {/* ── Upload Modal ── */}
      {uploadType && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.78)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: 24,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !uploading) {
              setUploadType(null)
              setUploading(false)
              setUploadProgress(0)
            }
          }}
        >
          <GlassPanel
            style={{
              width: '100%',
              maxWidth: 320,
              padding: 24,
              position: 'relative',
            }}
          >
            {/* Close */}
            {!uploading && (
              <button
                onClick={() => {
                  setUploadType(null)
                  setUploading(false)
                  setUploadProgress(0)
                }}
                style={{
                  position: 'absolute',
                  top: 12,
                  right: 12,
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: 'rgba(255,255,255,.06)',
                  border: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                <X size={16} color={T.textMuted} />
              </button>
            )}

            {/* Icon + Title */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 12,
                marginBottom: 24,
              }}
            >
              {(() => {
                const meta = docMeta(uploadType)
                const Icon = meta.icon
                return (
                  <div
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: 16,
                      background: meta.dim,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icon size={24} color={meta.color} />
                  </div>
                )
              })()}
              <h2
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  color: T.textPrimary,
                  margin: 0,
                }}
              >
                Upload {uploadType}
              </h2>
            </div>

            {/* Progress Bar */}
            {uploading && (
              <div
                style={{
                  width: '100%',
                  height: 6,
                  borderRadius: 3,
                  background: 'rgba(255,255,255,.08)',
                  marginBottom: 16,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${uploadProgress}%`,
                    height: '100%',
                    borderRadius: 3,
                    background: T.accentGradient,
                    transition: 'width 0.1s linear',
                  }}
                />
              </div>
            )}

            {uploading && (
              <p
                style={{
                  textAlign: 'center',
                  fontSize: 13,
                  color: T.textSecondary,
                  margin: 0,
                }}
              >
                Uploading... {uploadProgress}%
              </p>
            )}

            {/* Buttons */}
            {!uploading && (
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={handleUpload}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    padding: '12px 16px',
                    borderRadius: 12,
                    background: T.accentGradient,
                    border: 'none',
                    color: '#fff',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                >
                  <Camera size={16} />
                  Camera
                </button>
                <button
                  onClick={handleUpload}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    padding: '12px 16px',
                    borderRadius: 12,
                    background: 'rgba(255,255,255,.06)',
                    border: `1px solid rgba(255,255,255,.1)`,
                    color: T.textPrimary,
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                >
                  <Upload size={16} />
                  Files
                </button>
              </div>
            )}
          </GlassPanel>
        </div>
      )}

      {/* ── Delete Confirmation ── */}
      {deleteId && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.78)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            padding: 24,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setDeleteId(null)
          }}
        >
          <GlassPanel
            style={{
              width: '100%',
              maxWidth: 300,
              padding: 24,
              textAlign: 'center',
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 16,
                background: T.redDim,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px',
              }}
            >
              <Trash2 size={24} color={T.red} />
            </div>
            <h2
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: T.textPrimary,
                margin: 0,
                marginBottom: 6,
              }}
            >
              Delete Document?
            </h2>
            <p
              style={{
                fontSize: 13,
                color: T.textMuted,
                margin: 0,
                marginBottom: 24,
              }}
            >
              This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setDeleteId(null)}
                style={{
                  flex: 1,
                  padding: '12px 16px',
                  borderRadius: 12,
                  background: 'rgba(255,255,255,.06)',
                  border: `1px solid rgba(255,255,255,.1)`,
                  color: T.textPrimary,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                style={{
                  flex: 1,
                  padding: '12px 16px',
                  borderRadius: 12,
                  background: T.redDim,
                  border: `1px solid ${T.red}44`,
                  color: T.red,
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: deleting ? 'wait' : 'pointer',
                  transition: 'all 0.2s',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  opacity: deleting ? 0.7 : 1,
                }}
              >
                {deleting ? <><Loader2 size={14} style={{ animation: 'driverSpin 1s linear infinite' }} />Deleting...</> : 'Delete'}
              </button>
            </div>
          </GlassPanel>
        </div>
      )}
    </Page>
  )
}
