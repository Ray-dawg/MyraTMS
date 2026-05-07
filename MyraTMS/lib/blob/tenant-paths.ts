// =============================================================================
// Tenant-namespaced Vercel Blob path helpers.
//
// Spec: docs/architecture/STACK_DRIFT_REPORT.md §3.1 (Vercel Blob over R2)
//       docs/architecture/TENANTING_AUDIT.md §8 (per-tenant export, bucket-level deletion)
//
// Convention:
//   tenants/{tenantId}/{kind}/{filename}
//
// Where `kind` ∈ { documents, pods, exports, branding }. Anything that
// could be exported as part of "give me everything for tenant X" lives
// under this prefix; anything truly global (e.g. shared marketing assets)
// does not.
//
// Existing pre-Phase-3 blobs use flat keys like `documents/{filename}`.
// Those keep their original URLs forever — the @vercel/blob URL is the
// stable handle. New uploads go through these helpers; an offline migration
// (Phase 3.4 sub-task, not in Session 4 scope) can re-key in batches.
// =============================================================================

const ALLOWED_KINDS = ["documents", "pods", "exports", "branding"] as const
export type TenantBlobKind = (typeof ALLOWED_KINDS)[number]

/** Strip path traversal characters and slashes from an upload-supplied filename. */
function sanitizeFilename(filename: string): string {
  // Remove any directory traversal pieces and collapse to a flat name.
  const flat = filename.replace(/[\\/]+/g, "_").replace(/\.{2,}/g, "_")
  // Reject empty after sanitization
  if (!flat || flat === "_" || flat === ".") {
    throw new Error("tenant-paths: filename is empty after sanitization")
  }
  return flat
}

function assertValidTenantId(tenantId: number): void {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(
      `tenant-paths: tenantId must be a positive integer, got ${String(tenantId)}`,
    )
  }
}

/**
 * Build a tenant-namespaced blob key for a new upload.
 *
 * Example:
 *   tenantBlobKey(7, 'documents', 'BOL-LD-001.pdf')
 *     → 'tenants/7/documents/BOL-LD-001.pdf'
 *
 * The caller typically prepends a uuid/timestamp to `filename` for
 * uniqueness — this helper does NOT add randomness, because some kinds
 * (e.g. `branding/logo.png`) want a stable name.
 */
export function tenantBlobKey(
  tenantId: number,
  kind: TenantBlobKind,
  filename: string,
): string {
  assertValidTenantId(tenantId)
  if (!ALLOWED_KINDS.includes(kind)) {
    throw new Error(`tenant-paths: unknown kind "${kind}"`)
  }
  return `tenants/${tenantId}/${kind}/${sanitizeFilename(filename)}`
}

/**
 * Prefix used for `list({ prefix })` calls when you want every blob
 * belonging to one tenant — for export, audit, or hard-delete purge.
 */
export function tenantBlobPrefix(tenantId: number): string {
  assertValidTenantId(tenantId)
  return `tenants/${tenantId}/`
}

/**
 * Prefix scoped to one kind under a tenant — e.g. listing all documents
 * during an export run.
 */
export function tenantBlobKindPrefix(
  tenantId: number,
  kind: TenantBlobKind,
): string {
  assertValidTenantId(tenantId)
  if (!ALLOWED_KINDS.includes(kind)) {
    throw new Error(`tenant-paths: unknown kind "${kind}"`)
  }
  return `tenants/${tenantId}/${kind}/`
}

/**
 * Parse a blob key written by tenantBlobKey back into its parts. Returns
 * null for legacy flat keys (pre-Phase-3 uploads) so callers can branch
 * cleanly without try/catch.
 */
export function parseTenantBlobKey(
  key: string,
): { tenantId: number; kind: TenantBlobKind; filename: string } | null {
  const match = key.match(/^tenants\/(\d+)\/([^/]+)\/(.+)$/)
  if (!match) return null
  const tenantId = Number.parseInt(match[1], 10)
  const kind = match[2] as TenantBlobKind
  if (!Number.isInteger(tenantId) || tenantId <= 0) return null
  if (!ALLOWED_KINDS.includes(kind)) return null
  return { tenantId, kind, filename: match[3] }
}
