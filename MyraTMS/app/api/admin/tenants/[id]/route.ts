import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { asServiceAdmin } from "@/lib/db/tenant-context"
import { getCurrentUser, requireSuperAdmin } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

function parseTenantId(raw: string): number | null {
  const id = Number.parseInt(raw, 10)
  if (!Number.isInteger(id) || id <= 0) return null
  return id
}

/**
 * GET /api/admin/tenants/[id]
 *
 * Super-admin only. Returns the full tenant record plus its config row count
 * and user count so the admin UI can render an overview without a second call.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requireSuperAdmin(req)
  if (denied) return denied

  const { id: rawId } = await params
  const tenantId = parseTenantId(rawId)
  if (tenantId === null) return apiError("Invalid tenant id", 400)

  const result = await asServiceAdmin(
    `Admin tenant fetch (id=${tenantId})`,
    async (client) => {
      const { rows } = await client.query(
        `SELECT t.id, t.slug, t.name, t.type, t.status, t.parent_tenant_id,
                t.billing_email, t.primary_admin_user_id, t.created_at, t.updated_at,
                COALESCE((SELECT COUNT(*)::int FROM tenant_users tu WHERE tu.tenant_id = t.id), 0) AS user_count,
                COALESCE((SELECT COUNT(*)::int FROM tenant_config tc WHERE tc.tenant_id = t.id), 0) AS config_count,
                COALESCE((SELECT COUNT(*)::int FROM loads l WHERE l.tenant_id = t.id), 0) AS load_count
           FROM tenants t
          WHERE t.id = $1 AND t.deleted_at IS NULL
          LIMIT 1`,
        [tenantId],
      )
      return rows[0] ?? null
    },
  )

  if (!result) return apiError("Tenant not found", 404)
  return NextResponse.json({ tenant: result })
}

const PATCH_BODY = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(["active", "trial", "past_due", "suspended"]).optional(),
  billingEmail: z.string().email().nullable().optional(),
  primaryAdminUserId: z.string().min(1).nullable().optional(),
  parentTenantId: z.number().int().positive().nullable().optional(),
  reason: z.string().min(5).max(500),
})

/**
 * PATCH /api/admin/tenants/[id]
 *
 * Super-admin only. Updates mutable tenant fields. Slug is intentionally
 * NOT mutable here — slug changes affect subdomains and would require a
 * separate rename flow with redirect handling. `type` is also immutable
 * post-creation since it changes RBAC defaults.
 *
 * Status transitions to 'canceled' are blocked — use the purge endpoint
 * (which has the 24h delay + double confirmation safeguards).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requireSuperAdmin(req)
  if (denied) return denied
  const user = getCurrentUser(req)!

  const { id: rawId } = await params
  const tenantId = parseTenantId(rawId)
  if (tenantId === null) return apiError("Invalid tenant id", 400)

  let body: z.infer<typeof PATCH_BODY>
  try {
    body = PATCH_BODY.parse(await req.json())
  } catch (err) {
    if (err instanceof z.ZodError) {
      return apiError(
        `Invalid body: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        400,
      )
    }
    return apiError("Invalid JSON body", 400)
  }

  const updateFields: Array<{ col: string; value: unknown }> = []
  if (body.name !== undefined) updateFields.push({ col: "name", value: body.name })
  if (body.status !== undefined) updateFields.push({ col: "status", value: body.status })
  if (body.billingEmail !== undefined) {
    updateFields.push({ col: "billing_email", value: body.billingEmail })
  }
  if (body.primaryAdminUserId !== undefined) {
    updateFields.push({ col: "primary_admin_user_id", value: body.primaryAdminUserId })
  }
  if (body.parentTenantId !== undefined) {
    updateFields.push({ col: "parent_tenant_id", value: body.parentTenantId })
  }

  if (updateFields.length === 0) {
    return apiError("No fields to update", 400)
  }

  const result = await asServiceAdmin(
    `Admin tenant update (id=${tenantId}) by ${user.userId}: ${body.reason}`,
    async (client) => {
      const { rows: existingRows } = await client.query(
        `SELECT id, slug, name, status FROM tenants WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [tenantId],
      )
      if (existingRows.length === 0) return { notFound: true as const }
      const existing = existingRows[0]

      // Build the UPDATE with parameterized SET clauses. Column names are
      // from the typed updateFields array above (whitelisted), never from
      // the request body — no SQL injection vector here.
      const setClauses = updateFields
        .map((f, i) => `${f.col} = $${i + 1}`)
        .join(", ")
      const values = updateFields.map((f) => f.value)
      values.push(tenantId)

      await client.query(
        `UPDATE tenants SET ${setClauses}, updated_at = NOW() WHERE id = $${values.length}`,
        values,
      )

      await client.query(
        `INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
         VALUES ($1, $2, 'tenant_updated', $3::jsonb)`,
        [
          tenantId,
          user.userId,
          JSON.stringify({
            slug: existing.slug,
            changes: Object.fromEntries(updateFields.map((f) => [f.col, f.value])),
            reason: body.reason,
          }),
        ],
      )

      return { ok: true as const }
    },
  )

  if ("notFound" in result) return apiError("Tenant not found", 404)
  return NextResponse.json({ tenantId, updatedFields: updateFields.map((f) => f.col) })
}

/**
 * DELETE /api/admin/tenants/[id]
 *
 * Super-admin only. SOFT delete — sets deleted_at + status='canceled' but
 * keeps all data. Hard purge (with 24h delay + double confirmation) is a
 * separate endpoint per PERMISSIONS_MATRIX.md §3.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requireSuperAdmin(req)
  if (denied) return denied
  const user = getCurrentUser(req)!

  const { id: rawId } = await params
  const tenantId = parseTenantId(rawId)
  if (tenantId === null) return apiError("Invalid tenant id", 400)

  // Reason is required even for soft-delete — same audit standards as updates.
  const reason = req.nextUrl.searchParams.get("reason") || ""
  if (reason.length < 5) {
    return apiError("Query param 'reason' (min 5 chars) is required", 400)
  }

  const result = await asServiceAdmin(
    `Admin tenant soft-delete (id=${tenantId}) by ${user.userId}: ${reason}`,
    async (client) => {
      const { rows } = await client.query(
        `SELECT slug FROM tenants WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [tenantId],
      )
      if (rows.length === 0) return { notFound: true as const }
      const slug = rows[0].slug

      // Block self-soft-delete of the synthetic '_system' tenant — it is
      // load-bearing for cross-tenant audit logging.
      if (slug === "_system") {
        return { forbidden: true as const }
      }

      await client.query(
        `UPDATE tenants
            SET status = 'canceled', deleted_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [tenantId],
      )
      await client.query(
        `INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
         VALUES ($1, $2, 'tenant_soft_deleted', $3::jsonb)`,
        [tenantId, user.userId, JSON.stringify({ slug, reason })],
      )

      return { ok: true as const, slug }
    },
  )

  if ("notFound" in result) return apiError("Tenant not found", 404)
  if ("forbidden" in result) {
    return apiError("Cannot delete the system tenant", 403)
  }
  return NextResponse.json({ tenantId, deleted: true, slug: result.slug })
}
