import { NextRequest, NextResponse } from "next/server"
import { put } from "@vercel/blob"
import crypto from "crypto"
import { asServiceAdmin } from "@/lib/db/tenant-context"
import { getCurrentUser, requireSuperAdmin } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { tenantBlobKey } from "@/lib/blob/tenant-paths"
import { loadTenantSubscription } from "@/lib/features/loader"
import { requireFeature, gateErrorResponse } from "@/lib/features/gate"

/**
 * POST /api/admin/tenants/[id]/export
 *
 * Phase 3.4 (initial cut): produces a JSON dump of the tenant's data and
 * uploads it to tenants/{tenantId}/exports/{exportId}.json. The full
 * zip-with-blob-attachments export is documented as a follow-up session
 * (it needs streaming/archiver and likely Vercel Workflow for durability).
 *
 * The JSON file contains:
 *   - tenant row + tenant_config rows
 *   - tenant_users with joined user records
 *   - all Cat A table contents under that tenant_id
 *   - a manifest section listing blob URLs (so consumers can re-fetch
 *     attachments out-of-band)
 *
 * The export is exposed via a public Blob URL — operators decide whether
 * to share it. Audit log records the export id + URL.
 */

// Tables that should be included in the export. Order matters only for
// readability of the resulting JSON. Excludes the global tables
// (distance_cache, fuel_index, loadboard_sources) by design — those are
// shared across tenants and not part of any single tenant's data.
const EXPORTED_TABLES = [
  "tenant_config",
  "tenant_users",
  "users",
  "shippers",
  "carriers",
  "loads",
  "load_events",
  "drivers",
  "documents",
  "invoices",
  "tracking_tokens",
  "exceptions",
  "compliance_alerts",
  "match_results",
  "carrier_equipment",
  "carrier_lanes",
  "quotes",
  "settings",
  "workflows",
  "check_calls",
  "activity_notes",
  "notifications",
  "user_invites",
  "integrations",
] as const

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requireSuperAdmin(req)
  if (denied) return denied
  const user = getCurrentUser(req)!

  const { id: rawId } = await params
  const tenantId = Number.parseInt(rawId, 10)
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    return apiError("Invalid tenant id", 400)
  }

  // Bulk export is gated on data_export — Starter tenants don't get this.
  // The gate is on the SUBJECT tenant (the one being exported), not the
  // super-admin caller, so a Starter tenant's data cannot be exported even
  // by a super-admin via this endpoint.
  try {
    const sub = await loadTenantSubscription(tenantId)
    requireFeature(sub, "data_export")
  } catch (err) {
    const resp = gateErrorResponse(err)
    if (resp) return resp
    throw err
  }

  type ExportPayload = {
    manifest: Record<string, unknown>
    tenant: Record<string, unknown>
    tables: Record<string, unknown[]>
  }
  type ExportResult =
    | {
        ok: true
        exportId: string
        tenantSlug: string
        tableCounts: Record<string, number>
        payload: ExportPayload
      }
    | { ok: false; status: number; error: string }

  // Build the JSON payload entirely under asServiceAdmin (cross-tenant by
  // necessity — even the user records need the service_admin bypass to
  // read since users isn't directly Cat A but is referenced by tenant_users).
  const built: ExportResult = await asServiceAdmin(
    `Tenant export (id=${tenantId}) by ${user.userId}`,
    async (client): Promise<ExportResult> => {
      const { rows: tenantRows } = await client.query<{
        id: number
        slug: string
        name: string
      }>(
        `SELECT id, slug, name, type, status, parent_tenant_id, billing_email,
                primary_admin_user_id, created_at, updated_at
           FROM tenants WHERE id = $1 LIMIT 1`,
        [tenantId],
      )
      if (tenantRows.length === 0) {
        return { ok: false, status: 404, error: "Tenant not found" }
      }
      const tenant = tenantRows[0]

      const tableData: Record<string, unknown[]> = {}
      const tableCounts: Record<string, number> = {}

      // For each Cat A table, dump rows where tenant_id = $1.
      // tenant_config is keyed by (tenant_id, key) — same predicate.
      // tenant_users joins on tenant_id directly.
      // The `users` table is special — pull only users that have any
      // membership in this tenant.
      for (const table of EXPORTED_TABLES) {
        if (table === "users") {
          const { rows } = await client.query(
            `SELECT u.* FROM users u
               WHERE u.id IN (SELECT user_id FROM tenant_users WHERE tenant_id = $1)`,
            [tenantId],
          )
          tableData[table] = rows
          tableCounts[table] = rows.length
          continue
        }
        // Every other table has a tenant_id column post-migration 028.
        // Use parameterized $1 — the table name is from the EXPORTED_TABLES
        // whitelist literal, never user input.
        const { rows } = await client.query(
          `SELECT * FROM ${table} WHERE tenant_id = $1`,
          [tenantId],
        )
        tableData[table] = rows
        tableCounts[table] = rows.length
      }

      const exportId = `EXP-${Date.now().toString(36).toUpperCase()}-${crypto
        .randomBytes(3)
        .toString("hex")
        .toUpperCase()}`

      const manifest = {
        export_id: exportId,
        tenant: {
          id: tenant.id,
          slug: tenant.slug,
          name: tenant.name,
        },
        exported_at: new Date().toISOString(),
        exported_by: user.userId,
        schema_version: "029", // matches the latest applied migration
        table_counts: tableCounts,
        notes:
          "JSON-only export. Blob attachments (documents/PODs) are referenced by URL " +
          "but NOT bundled — fetch them separately using the URLs in documents.blob_url.",
      }

      const payload = {
        manifest,
        tenant: tenantRows[0],
        tables: tableData,
      }

      // Audit BEFORE upload so we have a record even if Blob write fails.
      await client.query(
        `INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
         VALUES ($1, $2, 'tenant_export_initiated', $3::jsonb)`,
        [
          tenantId,
          user.userId,
          JSON.stringify({
            export_id: exportId,
            table_counts: tableCounts,
          }),
        ],
      )

      return {
        ok: true,
        exportId,
        tenantSlug: tenant.slug,
        tableCounts,
        payload,
      }
    },
  )

  if (!built.ok) return apiError(built.error, built.status)

  const { payload } = built

  const blobKey = tenantBlobKey(tenantId, "exports", `${built.exportId}.json`)
  const json = JSON.stringify(payload, null, 2)
  const blob = await put(blobKey, json, {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
  })

  // Stamp the audit log with the final URL so cleanup can find it later.
  await asServiceAdmin(
    `Tenant export upload complete (id=${tenantId}, export=${built.exportId})`,
    async (client) => {
      await client.query(
        `INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
         VALUES ($1, $2, 'tenant_export_uploaded', $3::jsonb)`,
        [
          tenantId,
          user.userId,
          JSON.stringify({
            export_id: built.exportId,
            blob_url: blob.url,
            blob_key: blobKey,
            byte_size: json.length,
            table_counts: built.tableCounts,
          }),
        ],
      )
    },
  )

  return NextResponse.json(
    {
      tenantId,
      tenantSlug: built.tenantSlug,
      exportId: built.exportId,
      url: blob.url,
      blobKey,
      tableCounts: built.tableCounts,
      byteSize: json.length,
      note:
        "JSON export only. Blob attachments referenced by URL — bundle separately " +
        "using documents.blob_url values.",
    },
    { status: 201 },
  )
}
