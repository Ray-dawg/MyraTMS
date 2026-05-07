import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import crypto from "crypto"
import { asServiceAdmin } from "@/lib/db/tenant-context"
import { getCurrentUser, requireSuperAdmin } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { sendGenericEmail } from "@/lib/email"

function parseTenantId(raw: string): number | null {
  const id = Number.parseInt(raw, 10)
  if (!Number.isInteger(id) || id <= 0) return null
  return id
}

/**
 * GET /api/admin/tenants/[id]/users
 *
 * Super-admin only. Lists all users that belong to the given tenant
 * (joined from tenant_users → users), plus their role and primary flag.
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

  const data = await asServiceAdmin(
    `Admin tenant users list (tenant=${tenantId})`,
    async (client) => {
      const { rows: tenantRows } = await client.query(
        `SELECT id, slug FROM tenants WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [tenantId],
      )
      if (tenantRows.length === 0) return null

      const { rows: members } = await client.query(
        `SELECT u.id, u.email, u.first_name, u.last_name,
                tu.role, tu.is_primary, tu.joined_at
           FROM tenant_users tu
           JOIN users u ON u.id = tu.user_id
          WHERE tu.tenant_id = $1
          ORDER BY tu.is_primary DESC, tu.joined_at`,
        [tenantId],
      )

      const { rows: pendingInvites } = await client.query(
        `SELECT id, email, role, first_name, last_name, status, expires_at, created_at
           FROM user_invites
          WHERE tenant_id = $1 AND status = 'pending' AND expires_at > NOW()
          ORDER BY created_at DESC`,
        [tenantId],
      )

      return { tenant: tenantRows[0], members, pendingInvites }
    },
  )

  if (data === null) return apiError("Tenant not found", 404)

  return NextResponse.json({
    tenantId,
    members: data.members,
    pendingInvites: data.pendingInvites,
  })
}

const INVITE_BODY = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "operator", "viewer", "owner"]),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  reason: z.string().min(5).max(500),
})

/**
 * POST /api/admin/tenants/[id]/users
 *
 * Super-admin only. Invites a user (by email) to join the given tenant.
 * Body must specify role (admin/operator/viewer/owner).
 *
 * Cross-tenant uniqueness: an email may already have an account in
 * another tenant. In that case we DO NOT create a new user — the accept
 * flow will add a tenant_users row to the existing user instead.
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

  let body: z.infer<typeof INVITE_BODY>
  try {
    body = INVITE_BODY.parse(await req.json())
  } catch (err) {
    if (err instanceof z.ZodError) {
      return apiError(
        `Invalid body: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        400,
      )
    }
    return apiError("Invalid JSON body", 400)
  }

  const normalizedEmail = body.email.toLowerCase().trim()

  type InviteResult =
    | { ok: true; inviteId: string; token: string; alreadyMember: boolean }
    | { ok: false; status: number; error: string }

  const result = await asServiceAdmin(
    `Admin invite user '${normalizedEmail}' to tenant ${tenantId} as ${body.role} by ${user.userId}: ${body.reason}`,
    async (client): Promise<InviteResult> => {
      // 1. Verify the tenant exists
      const { rows: tenantRows } = await client.query<{ slug: string }>(
        `SELECT slug FROM tenants WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [tenantId],
      )
      if (tenantRows.length === 0) {
        return { ok: false, status: 404, error: "Tenant not found" }
      }

      // 2. If a user with this email already exists AND is already a member
      //    of this tenant, no-op with a clear response.
      const { rows: existingUser } = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1 LIMIT 1`,
        [normalizedEmail],
      )
      if (existingUser.length > 0) {
        const userId = existingUser[0].id
        const { rows: membership } = await client.query(
          `SELECT user_id FROM tenant_users WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
          [tenantId, userId],
        )
        if (membership.length > 0) {
          return {
            ok: false,
            status: 409,
            error: "User is already a member of this tenant",
          }
        }
      }

      // 3. Already a pending invite for this email + this tenant?
      const { rows: pending } = await client.query(
        `SELECT id FROM user_invites
          WHERE tenant_id = $1 AND email = $2 AND status = 'pending' AND expires_at > NOW()
          LIMIT 1`,
        [tenantId, normalizedEmail],
      )
      if (pending.length > 0) {
        return {
          ok: false,
          status: 409,
          error: "A pending invite for this email already exists in this tenant",
        }
      }

      // 4. Create the invite. The accept flow (auth/accept-invite) will
      //    look up the existing user-or-create-new based on email and
      //    insert the tenant_users row.
      const inviteId = `INV-${Date.now().toString(36).toUpperCase()}`
      const token = crypto.randomBytes(32).toString("hex")
      // user_invites.role only allows ('admin','broker') currently — coerce
      // operator/viewer/owner to the closest supported value until 022 is
      // updated to mirror the tenant_users role enum. Owner/admin → 'admin';
      // operator/viewer → 'broker' (least privilege of the legacy two).
      const legacyInviteRole =
        body.role === "owner" || body.role === "admin" ? "admin" : "broker"

      await client.query(
        `INSERT INTO user_invites (id, tenant_id, email, role, first_name, last_name, token, invited_by, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW() + INTERVAL '7 days', NOW())`,
        [
          inviteId,
          tenantId,
          normalizedEmail,
          legacyInviteRole,
          body.firstName ?? null,
          body.lastName ?? null,
          token,
          user.userId,
        ],
      )

      await client.query(
        `INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
         VALUES ($1, $2, 'tenant_user_invited', $3::jsonb)`,
        [
          tenantId,
          user.userId,
          JSON.stringify({
            email: normalizedEmail,
            role: body.role,
            invite_id: inviteId,
            reason: body.reason,
          }),
        ],
      )

      return {
        ok: true,
        inviteId,
        token,
        alreadyMember: false,
      }
    },
  )

  if (!result.ok) return apiError(result.error, result.status)

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
  const inviteUrl = `${appUrl}/invite/${result.token}`

  // Best-effort email — failure does not roll back the invite.
  const emailSent = await sendGenericEmail(
    normalizedEmail,
    `You're invited to join a Myra TMS tenant`,
    `<p>You've been invited to join a Myra TMS tenant as <strong>${body.role}</strong>.</p>` +
      `<p>Accept here: <a href="${inviteUrl}">${inviteUrl}</a></p>` +
      `<p>This invite expires in 7 days.</p>`,
  )

  return NextResponse.json(
    {
      tenantId,
      inviteId: result.inviteId,
      inviteUrl,
      role: body.role,
      emailSent,
    },
    { status: 201 },
  )
}
