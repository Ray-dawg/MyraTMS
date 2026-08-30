import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { asServiceAdmin } from "@/lib/db/tenant-context"
import { getCurrentUser, requireSuperAdmin } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { cloneDefaultTenantConfig, seatTenantOwner } from "@/lib/tenants/provision"

const ONBOARD_BODY = z.object({
  // The user that will own this tenant. Must already exist in `users`.
  // Onboarding cannot create the user — the invite/accept flow does that.
  ownerUserId: z.string().min(1),
  // Optional one-shot config overrides applied AFTER cloning defaults.
  // Useful for "set timezone to America/Vancouver during onboarding".
  configOverrides: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().min(5).max(500),
})

/**
 * POST /api/admin/tenants/[id]/onboard
 *
 * Bootstraps a tenant after creation. Idempotent — re-running on a
 * partially-onboarded tenant fills in any missing config rows without
 * overwriting ones already set by the wizard.
 *
 * Steps:
 *   1. Verify the owner user exists.
 *   2. Clone DEFAULT_TENANT_CONFIG into tenant_config (skipping rows
 *      that already exist — preserves any wizard-set values).
 *   3. Apply optional configOverrides (idempotent upsert).
 *   4. Add the owner to tenant_users with role='owner', is_primary=true.
 *   5. Stamp tenants.primary_admin_user_id and flip status='active' if
 *      currently 'trial'.
 *   6. Audit each step.
 */
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

  let body: z.infer<typeof ONBOARD_BODY>
  try {
    body = ONBOARD_BODY.parse(await req.json())
  } catch (err) {
    if (err instanceof z.ZodError) {
      return apiError(
        `Invalid body: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        400,
      )
    }
    return apiError("Invalid JSON body", 400)
  }

  type OnboardResult =
    | { ok: true; configRowsAdded: number; ownerSeated: boolean; statusChangedTo: string | null }
    | { ok: false; status: number; error: string }

  const result = await asServiceAdmin(
    `Tenant onboarding (id=${tenantId}, owner=${body.ownerUserId}) by ${user.userId}: ${body.reason}`,
    async (client): Promise<OnboardResult> => {
      // 1. Tenant must exist (and not be soft-deleted)
      const { rows: tenantRows } = await client.query<{
        id: number
        slug: string
        status: string
        primary_admin_user_id: string | null
      }>(
        `SELECT id, slug, status, primary_admin_user_id
           FROM tenants
          WHERE id = $1 AND deleted_at IS NULL
          LIMIT 1`,
        [tenantId],
      )
      if (tenantRows.length === 0) {
        return { ok: false, status: 404, error: "Tenant not found" }
      }
      const tenant = tenantRows[0]

      // 2. Owner user must exist (auth/invite flow creates it)
      const { rows: userRows } = await client.query(
        `SELECT id FROM users WHERE id = $1 LIMIT 1`,
        [body.ownerUserId],
      )
      if (userRows.length === 0) {
        return {
          ok: false,
          status: 400,
          error: `Owner user '${body.ownerUserId}' not found — create via /api/auth/accept-invite first`,
        }
      }

      // 3. Clone DEFAULT_TENANT_CONFIG into tenant_config — but skip any
      //    keys already present (preserves wizard-set values on re-runs).
      //    Delegated to lib/tenants/provision.ts so this route and T-28's
      //    self-serve flow share the same code path.
      const { configRowsAdded } = await cloneDefaultTenantConfig(client, tenantId)

      // 4. Apply optional configOverrides — these win even on re-runs
      if (body.configOverrides) {
        for (const [key, value] of Object.entries(body.configOverrides)) {
          await client.query(
            `INSERT INTO tenant_config (tenant_id, key, value, encrypted, updated_at, updated_by)
             VALUES ($1, $2, $3, false, NOW(), $4)
             ON CONFLICT (tenant_id, key) DO UPDATE
               SET value = EXCLUDED.value,
                   updated_at = NOW(),
                   updated_by = EXCLUDED.updated_by`,
            [tenantId, key, JSON.stringify(value), `system:onboard:${user.userId}`],
          )
        }
      }

      // 5. Seat the owner if not already in tenant_users. Delegated to
      //    lib/tenants/provision.ts so this route and T-28's self-serve
      //    flow share the same code path.
      const { ownerSeated } = await seatTenantOwner(client, tenantId, body.ownerUserId)

      // 6. Stamp primary_admin_user_id; flip 'trial' → 'active'
      let statusChangedTo: string | null = null
      const newStatus = tenant.status === "trial" ? "active" : null
      if (newStatus !== null || tenant.primary_admin_user_id !== body.ownerUserId) {
        await client.query(
          `UPDATE tenants
              SET primary_admin_user_id = $1,
                  status = COALESCE($2, status),
                  updated_at = NOW()
            WHERE id = $3`,
          [body.ownerUserId, newStatus, tenantId],
        )
        statusChangedTo = newStatus
      }

      // 7. Audit
      await client.query(
        `INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
         VALUES ($1, $2, 'tenant_onboarded', $3::jsonb)`,
        [
          tenantId,
          user.userId,
          JSON.stringify({
            slug: tenant.slug,
            owner_user_id: body.ownerUserId,
            config_rows_added: configRowsAdded,
            owner_seated: ownerSeated,
            status_changed_to: statusChangedTo,
            override_keys: body.configOverrides ? Object.keys(body.configOverrides) : [],
            reason: body.reason,
          }),
        ],
      )

      return { ok: true, configRowsAdded, ownerSeated, statusChangedTo }
    },
  )

  if (!result.ok) return apiError(result.error, result.status)

  return NextResponse.json({
    tenantId,
    onboarded: true,
    configRowsAdded: result.configRowsAdded,
    ownerSeated: result.ownerSeated,
    statusChangedTo: result.statusChangedTo,
  })
}
