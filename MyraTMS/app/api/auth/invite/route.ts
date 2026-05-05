import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { withTenant } from "@/lib/db/tenant-context"
import { asServiceAdmin } from "@/lib/db/tenant-context"
import { getCurrentUser, requireRole, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { sendGenericEmail } from "@/lib/email"

// POST — Admin sends an invite to create a broker/admin account
export async function POST(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const denied = requireRole(user, "admin")
  if (denied) return denied

  const ctx = requireTenantContext(req)

  const body = await req.json()
  const { email, role, firstName, lastName } = body

  if (!email || !role) {
    return apiError("email and role are required", 400)
  }
  if (!["admin", "broker"].includes(role)) {
    return apiError("role must be 'admin' or 'broker'", 400)
  }

  const normalizedEmail = email.toLowerCase().trim()

  // Cross-tenant uniqueness check: email must be globally unique across all tenants.
  const emailTaken = await asServiceAdmin(
    "Cross-tenant email uniqueness check for new invite",
    async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM users WHERE email = $1 LIMIT 1`,
        [normalizedEmail],
      )
      return rows.length > 0
    },
  )
  if (emailTaken) {
    return apiError("A user with this email already exists", 409)
  }

  // Generate invite token
  const token = crypto.randomBytes(32).toString("hex")
  const inviteId = `INV-${Date.now().toString(36).toUpperCase()}`

  // Within the inviter's tenant: dupe-check pending invites + insert.
  const dupeInvite = await withTenant(ctx.tenantId, async (client) => {
    const { rows: pending } = await client.query(
      `SELECT id FROM user_invites
        WHERE email = $1 AND status = 'pending' AND expires_at > NOW()
        LIMIT 1`,
      [normalizedEmail],
    )
    if (pending.length > 0) return true

    await client.query(
      `INSERT INTO user_invites (id, email, role, first_name, last_name, token, invited_by, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW() + INTERVAL '7 days', NOW())`,
      [
        inviteId,
        normalizedEmail,
        role,
        firstName || null,
        lastName || null,
        token,
        user.userId,
      ],
    )
    return false
  })
  if (dupeInvite) {
    return apiError("A pending invite already exists for this email", 409)
  }

  // Build invite URL
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
  const inviteUrl = `${appUrl}/invite/${token}`

  // Send email (no-ops if SMTP not configured)
  const emailSent = await sendGenericEmail(
    email,
    "You're invited to join Myra Logistics",
    buildInviteEmailHtml({
      recipientName: firstName || email,
      inviteUrl,
      role,
      invitedBy: `${user.firstName} ${user.lastName}`,
      companyName: "Myra Logistics",
    })
  )

  return NextResponse.json({
    invite: {
      id: inviteId,
      email,
      role,
      inviteUrl,
      emailSent,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  }, { status: 201 })
}

// GET — List all invites for the caller's tenant (admin only)
export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const denied = requireRole(user, "admin")
  if (denied) return denied

  const ctx = requireTenantContext(req)

  const invites = await withTenant(ctx.tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, email, role, first_name, last_name, status, expires_at, created_at,
         CASE WHEN expires_at < NOW() AND status = 'pending' THEN 'expired' ELSE status END as display_status
         FROM user_invites
        ORDER BY created_at DESC
        LIMIT 50`,
    )
    return rows
  })

  return NextResponse.json({ invites })
}

function buildInviteEmailHtml(params: {
  recipientName: string
  inviteUrl: string
  role: string
  invitedBy: string
  companyName: string
}): string {
  const { recipientName, inviteUrl, role, invitedBy, companyName } = params
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:40px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <tr>
      <td style="background:#0f172a;padding:24px 32px;">
        <span style="color:#ffffff;font-size:18px;font-weight:600;">Myra</span>
        <span style="color:#e8601f;font-size:18px;font-weight:600;"> AI</span>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <p style="margin:0 0 16px;color:#18181b;font-size:15px;line-height:1.6;">
          Hi ${recipientName},
        </p>
        <p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6;">
          ${invitedBy} has invited you to join <strong>${companyName}</strong> as a <strong>${role}</strong>
          on the Myra AI Transportation Management System.
        </p>
        <p style="margin:0 0 24px;color:#3f3f46;font-size:14px;line-height:1.6;">
          Click the button below to create your account. This invitation expires in 7 days.
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:24px 0;">
          <tr>
            <td style="background:#e8601f;border-radius:8px;">
              <a href="${inviteUrl}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">
                Accept Invitation
              </a>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 8px;color:#71717a;font-size:12px;">Or copy this link:</p>
        <p style="margin:0;color:#3b82f6;font-size:12px;word-break:break-all;">
          <a href="${inviteUrl}" style="color:#3b82f6;">${inviteUrl}</a>
        </p>
        <hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0;" />
        <p style="margin:0;color:#a1a1aa;font-size:11px;">
          If you did not expect this invitation, you can safely ignore this email.
        </p>
      </td>
    </tr>
    <tr>
      <td style="background:#fafafa;padding:16px 32px;border-top:1px solid #e4e4e7;">
        <p style="margin:0;color:#a1a1aa;font-size:10px;">&copy; ${new Date().getFullYear()} Myra AI, Inc.</p>
      </td>
    </tr>
  </table>
</body>
</html>`.trim()
}
