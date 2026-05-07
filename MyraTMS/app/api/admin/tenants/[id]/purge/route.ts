import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { asServiceAdmin } from "@/lib/db/tenant-context"
import { getCurrentUser, requireSuperAdmin } from "@/lib/auth"
import { apiError } from "@/lib/api-error"

/**
 * Tenant purge endpoints — the most destructive operation in the platform.
 *
 * Per PERMISSIONS_MATRIX.md §3 — hard-delete requires:
 *   1. Super-admin role
 *   2. 24-hour delay between scheduling and execution
 *   3. Double confirmation: requester must POST the tenant slug verbatim
 *      in the body (typo-safe), and the tenant must already be soft-deleted
 *
 * State is tracked exclusively via tenant_audit_log entries:
 *   - 'tenant_purge_scheduled' starts the 24h clock
 *   - 'tenant_purge_cancelled' before execution stops it
 *   - 'tenant_purge_executed' is recorded by the future executor cron
 *
 * This file exposes scheduling (POST) and cancellation (DELETE) only.
 * The executor that actually drops rows is a separate cron — documented
 * in SESSION_4_SUMMARY.md §3 as a follow-up.
 */

const PURGE_DELAY_HOURS = 24

function parseTenantId(raw: string): number | null {
  const id = Number.parseInt(raw, 10)
  if (!Number.isInteger(id) || id <= 0) return null
  return id
}

const SCHEDULE_BODY = z.object({
  // Caller must type the tenant slug verbatim — protects against
  // copy-paste-of-the-wrong-id and against UI bugs that target the
  // wrong tenant.
  slugConfirmation: z.string().min(1),
  reason: z.string().min(20).max(1000),
})

/**
 * POST /api/admin/tenants/[id]/purge
 *
 * Schedule a hard-delete. Body must echo the tenant's slug exactly.
 * Tenant must already be soft-deleted (deleted_at NOT NULL).
 *
 * Returns the scheduled execution time (NOW + 24h).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requireSuperAdmin(req)
  if (denied) return denied
  const user = getCurrentUser(req)!

  const { id: rawId } = await params
  const tenantId = parseTenantId(rawId)
  if (tenantId === null) return apiError("Invalid tenant id", 400)

  let body: z.infer<typeof SCHEDULE_BODY>
  try {
    body = SCHEDULE_BODY.parse(await req.json())
  } catch (err) {
    if (err instanceof z.ZodError) {
      return apiError(
        `Invalid body: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        400,
      )
    }
    return apiError("Invalid JSON body", 400)
  }

  type PurgeScheduleResult =
    | { ok: true; scheduledFor: string }
    | { ok: false; status: number; error: string }

  const result = await asServiceAdmin(
    `Schedule tenant purge (id=${tenantId}) by ${user.userId}: ${body.reason}`,
    async (client): Promise<PurgeScheduleResult> => {
      // Tenant must exist (soft-deleted is fine — required, in fact)
      const { rows: tenantRows } = await client.query<{
        id: number
        slug: string
        deleted_at: string | null
      }>(
        `SELECT id, slug, deleted_at FROM tenants WHERE id = $1 LIMIT 1`,
        [tenantId],
      )
      if (tenantRows.length === 0) {
        return { ok: false, status: 404, error: "Tenant not found" }
      }
      const tenant = tenantRows[0]

      if (tenant.slug === "_system") {
        return { ok: false, status: 403, error: "Cannot purge the system tenant" }
      }

      // Slug confirmation must match exactly
      if (body.slugConfirmation !== tenant.slug) {
        return {
          ok: false,
          status: 400,
          error: `Slug confirmation mismatch — expected '${tenant.slug}'`,
        }
      }

      // Tenant must already be soft-deleted. Forces operators to follow
      // the soft-delete-then-purge pattern (which gives 1+ extra review
      // points to catch mistakes).
      if (!tenant.deleted_at) {
        return {
          ok: false,
          status: 400,
          error: "Tenant must be soft-deleted before scheduling a purge (DELETE /api/admin/tenants/{id} first)",
        }
      }

      // Reject if a purge is already scheduled and not cancelled/executed
      const { rows: pending } = await client.query<{ scheduled_for: string }>(
        `SELECT (event_payload->>'scheduled_for') AS scheduled_for
           FROM tenant_audit_log
          WHERE tenant_id = $1
            AND event_type = 'tenant_purge_scheduled'
            AND created_at > NOW() - INTERVAL '7 days'
            AND NOT EXISTS (
              SELECT 1 FROM tenant_audit_log later
               WHERE later.tenant_id = $1
                 AND later.created_at > tenant_audit_log.created_at
                 AND later.event_type IN ('tenant_purge_cancelled', 'tenant_purge_executed')
            )
          ORDER BY created_at DESC
          LIMIT 1`,
        [tenantId],
      )
      if (pending.length > 0) {
        return {
          ok: false,
          status: 409,
          error: `Purge already scheduled for ${pending[0].scheduled_for} — cancel first via DELETE`,
        }
      }

      const { rows: schedRows } = await client.query<{
        scheduled_for: string
      }>(
        `INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
         VALUES ($1, $2, 'tenant_purge_scheduled', $3::jsonb)
         RETURNING (event_payload->>'scheduled_for') AS scheduled_for`,
        [
          tenantId,
          user.userId,
          JSON.stringify({
            slug: tenant.slug,
            scheduled_for: new Date(
              Date.now() + PURGE_DELAY_HOURS * 60 * 60 * 1000,
            ).toISOString(),
            scheduled_by: user.userId,
            delay_hours: PURGE_DELAY_HOURS,
            reason: body.reason,
          }),
        ],
      )

      return { ok: true, scheduledFor: schedRows[0].scheduled_for }
    },
  )

  if (!result.ok) return apiError(result.error, result.status)

  return NextResponse.json({
    tenantId,
    purgeScheduled: true,
    scheduledFor: result.scheduledFor,
    delayHours: PURGE_DELAY_HOURS,
    note: `Cancellable via DELETE before ${result.scheduledFor}`,
  })
}

/**
 * DELETE /api/admin/tenants/[id]/purge
 *
 * Cancel a pending purge. Idempotent — returns 200 if no pending purge exists.
 * Reason is required so the audit trail explains the cancellation.
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

  const reason = req.nextUrl.searchParams.get("reason") || ""
  if (reason.length < 5) {
    return apiError("Query param 'reason' (min 5 chars) is required", 400)
  }

  const cancelled = await asServiceAdmin(
    `Cancel tenant purge (id=${tenantId}) by ${user.userId}: ${reason}`,
    async (client) => {
      const { rows } = await client.query<{ scheduled_for: string }>(
        `SELECT (event_payload->>'scheduled_for') AS scheduled_for
           FROM tenant_audit_log
          WHERE tenant_id = $1
            AND event_type = 'tenant_purge_scheduled'
            AND created_at > NOW() - INTERVAL '7 days'
            AND NOT EXISTS (
              SELECT 1 FROM tenant_audit_log later
               WHERE later.tenant_id = $1
                 AND later.created_at > tenant_audit_log.created_at
                 AND later.event_type IN ('tenant_purge_cancelled', 'tenant_purge_executed')
            )
          ORDER BY created_at DESC
          LIMIT 1`,
        [tenantId],
      )

      if (rows.length === 0) return { hadPending: false }

      await client.query(
        `INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
         VALUES ($1, $2, 'tenant_purge_cancelled', $3::jsonb)`,
        [
          tenantId,
          user.userId,
          JSON.stringify({
            cancelled_scheduled_for: rows[0].scheduled_for,
            cancelled_by: user.userId,
            reason,
          }),
        ],
      )

      return { hadPending: true, cancelledScheduledFor: rows[0].scheduled_for }
    },
  )

  return NextResponse.json({
    tenantId,
    cancelled: cancelled.hadPending,
    cancelledScheduledFor: cancelled.hadPending ? cancelled.cancelledScheduledFor : null,
  })
}
