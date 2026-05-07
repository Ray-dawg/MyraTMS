import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { asServiceAdmin } from "@/lib/db/tenant-context"
import { getCurrentUser, requireSuperAdmin } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import {
  assertValidTenantSlug,
  RESERVED_TENANT_SLUGS,
} from "@/lib/tenants/validators"

/**
 * GET /api/admin/tenants
 *
 * Super-admin only. Lists every tenant in the platform with status counts.
 * The synthetic '_system' tenant is always excluded — it exists only to
 * receive cross-tenant audit-log events.
 */
export async function GET(req: NextRequest) {
  const denied = requireSuperAdmin(req)
  if (denied) return denied

  const tenants = await asServiceAdmin(
    "Admin tenants list (cross-tenant by definition)",
    async (client) => {
      const { rows } = await client.query<{
        id: number
        slug: string
        name: string
        type: string
        status: string
        parent_tenant_id: number | null
        billing_email: string | null
        primary_admin_user_id: string | null
        created_at: string
        user_count: number
        load_count: number
      }>(
        `SELECT t.id, t.slug, t.name, t.type, t.status, t.parent_tenant_id,
                t.billing_email, t.primary_admin_user_id, t.created_at,
                COALESCE((SELECT COUNT(*)::int FROM tenant_users tu WHERE tu.tenant_id = t.id), 0) AS user_count,
                COALESCE((SELECT COUNT(*)::int FROM loads l WHERE l.tenant_id = t.id), 0) AS load_count
           FROM tenants t
          WHERE t.deleted_at IS NULL
            AND t.slug <> '_system'
          ORDER BY t.id`,
      )
      return rows
    },
  )

  return NextResponse.json({ tenants, count: tenants.length })
}

const CREATE_BODY = z.object({
  slug: z.string(),
  name: z.string().min(1).max(200),
  type: z.enum(["operating_company", "saas_customer", "internal"]),
  parentTenantId: z.number().int().positive().nullable().optional(),
  billingEmail: z.string().email().nullable().optional(),
  // The starting status — defaults to 'trial' so a tenant can be created
  // without committing to billing yet. Onboarding flips it to 'active'.
  status: z
    .enum(["active", "trial", "past_due", "suspended"])
    .optional()
    .default("trial"),
})

/**
 * POST /api/admin/tenants
 *
 * Super-admin only. Creates a tenant row but does NOT yet provision it —
 * tenant_config defaults are cloned by /onboard. This split lets the
 * platform owner create a placeholder tenant before the customer's owner
 * user accepts their invite.
 */
export async function POST(req: NextRequest) {
  const denied = requireSuperAdmin(req)
  if (denied) return denied
  // requireSuperAdmin already validated the JWT; we re-fetch only to record
  // who took the action in the audit log.
  const user = getCurrentUser(req)!

  let body: z.infer<typeof CREATE_BODY>
  try {
    body = CREATE_BODY.parse(await req.json())
  } catch (err) {
    if (err instanceof z.ZodError) {
      return apiError(
        `Invalid body: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        400,
      )
    }
    return apiError("Invalid JSON body", 400)
  }

  // Normalize + validate the slug (regex + reserved list)
  const slug = body.slug.trim().toLowerCase()
  try {
    assertValidTenantSlug(slug)
  } catch (err) {
    return apiError(err instanceof Error ? err.message : "Invalid slug", 400)
  }
  if (RESERVED_TENANT_SLUGS.has(slug)) {
    return apiError(`Slug '${slug}' is reserved`, 400)
  }

  const result = await asServiceAdmin(
    `Create tenant '${slug}' by super-admin ${user.userId}`,
    async (client) => {
      // Slug uniqueness check before insert so the API returns a clean 409
      // instead of a Postgres unique-constraint error string.
      const { rows: existing } = await client.query(
        `SELECT id FROM tenants WHERE slug = $1 LIMIT 1`,
        [slug],
      )
      if (existing.length > 0) {
        return { conflict: true as const }
      }

      const { rows } = await client.query<{ id: number; created_at: string }>(
        `INSERT INTO tenants (slug, name, type, parent_tenant_id, billing_email, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, created_at`,
        [
          slug,
          body.name,
          body.type,
          body.parentTenantId ?? null,
          body.billingEmail ?? null,
          body.status,
        ],
      )

      const tenantId = rows[0].id

      // Audit the creation against the new tenant's id so it appears in
      // both per-tenant audit views and the platform-wide super-admin log.
      await client.query(
        `INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
         VALUES ($1, $2, 'tenant_created', $3::jsonb)`,
        [
          tenantId,
          user.userId,
          JSON.stringify({
            slug,
            name: body.name,
            type: body.type,
            status: body.status,
          }),
        ],
      )

      return { tenantId, createdAt: rows[0].created_at }
    },
  )

  if ("conflict" in result) {
    return apiError(`Tenant slug '${slug}' already exists`, 409)
  }

  return NextResponse.json(
    {
      tenant: {
        id: result.tenantId,
        slug,
        name: body.name,
        type: body.type,
        status: body.status,
        parent_tenant_id: body.parentTenantId ?? null,
        billing_email: body.billingEmail ?? null,
        created_at: result.createdAt,
      },
      onboardUrl: `/api/admin/tenants/${result.tenantId}/onboard`,
    },
    { status: 201 },
  )
}
