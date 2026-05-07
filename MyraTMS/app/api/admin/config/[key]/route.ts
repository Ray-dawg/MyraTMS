import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireRole, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { encrypt, decrypt, maskCredential } from "@/lib/crypto/tenant-secrets"
import {
  isEncryptedConfigKey,
  isKnownConfigKey,
  validateConfigValue,
} from "@/lib/tenants/config-schema"

const PATCH_BODY = z.object({
  value: z.unknown(),
  // Audit-log reason. Required so post-incident forensics can ask "why did
  // this change?" and get an answer that wasn't auto-generated.
  reason: z.string().min(5).max(500),
})

/**
 * PATCH /api/admin/config/[key]
 *
 * Body: { value: <typed-per-key>, reason: string }
 *
 * Behavior (per TENANT_CONFIG_SEMANTICS.md §5):
 *   - Validates value with the per-key Zod schema in lib/tenants/config-schema.ts
 *   - For encrypted keys: encrypts server-side; the client never handles ciphertext
 *   - Upserts tenant_config row; stamps updated_at/updated_by
 *   - Logs to tenant_audit_log with event_type='tenant_config_changed'
 *     and a payload that masks both old and new values for sensitive keys
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const denied = requireRole(user, "admin", "owner", "service_admin")
  if (denied) return denied

  const ctx = requireTenantContext(req)
  const { key } = await params

  if (!isKnownConfigKey(key)) {
    return apiError(`Unknown config key '${key}'`, 404)
  }

  let body: z.infer<typeof PATCH_BODY>
  try {
    body = PATCH_BODY.parse(await req.json())
  } catch (err) {
    if (err instanceof z.ZodError) {
      return apiError(
        `Invalid request body: ${err.issues.map((i) => i.message).join("; ")}`,
        400,
      )
    }
    return apiError("Invalid JSON body", 400)
  }

  // Per-key value validation. Throws ZodError for malformed shapes.
  let validated: unknown
  try {
    validated = validateConfigValue(key, body.value)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return apiError(
        `Invalid value for '${key}': ${err.issues.map((i) => i.message).join("; ")}`,
        400,
      )
    }
    throw err
  }

  const encrypted = isEncryptedConfigKey(key)
  // Storage: encrypted keys store ciphertext, plaintext keys store JSON.stringify.
  // For encrypted keys we coerce to string first — credentials are always strings.
  const storedValue = encrypted
    ? encrypt(typeof validated === "string" ? validated : JSON.stringify(validated))
    : JSON.stringify(validated)

  const summary = await withTenant(ctx.tenantId, async (client) => {
    // Capture the old value for the audit log before overwriting.
    const { rows: existing } = await client.query<{
      value: string
      encrypted: boolean
    }>(
      `SELECT value, encrypted FROM tenant_config WHERE key = $1 LIMIT 1`,
      [key],
    )

    let oldDisplay: string | null = null
    if (existing.length > 0) {
      const row = existing[0]
      if (row.encrypted) {
        try {
          oldDisplay = maskCredential(decrypt(row.value))
        } catch {
          oldDisplay = "***decrypt-error***"
        }
      } else {
        oldDisplay = row.value
      }
    }

    // Upsert the new value. tenant_config primary key is (tenant_id, key);
    // RLS scopes the row by tenant_id automatically inside withTenant.
    await client.query(
      `INSERT INTO tenant_config (tenant_id, key, value, encrypted, updated_at, updated_by)
       VALUES (current_setting('app.current_tenant_id')::bigint, $1, $2, $3, NOW(), $4)
       ON CONFLICT (tenant_id, key) DO UPDATE
         SET value = EXCLUDED.value,
             encrypted = EXCLUDED.encrypted,
             updated_at = NOW(),
             updated_by = EXCLUDED.updated_by`,
      [key, storedValue, encrypted, user.userId],
    )

    // Audit. Both old and new values are masked for sensitive keys; numbers
    // and small enums are recorded as-is for plaintext keys so reviewers can
    // see what actually changed without round-tripping the DB.
    const newDisplay = encrypted
      ? "<encrypted>"
      : JSON.stringify(validated)
    const oldDisplayForAudit = encrypted ? "<encrypted>" : oldDisplay

    await client.query(
      `INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
       VALUES (
         current_setting('app.current_tenant_id')::bigint,
         $1, 'tenant_config_changed', $2::jsonb
       )`,
      [
        user.userId,
        JSON.stringify({
          key,
          old_value: oldDisplayForAudit,
          new_value: newDisplay,
          encrypted,
          reason: body.reason,
        }),
      ],
    )

    return { previouslySet: existing.length > 0 }
  })

  return NextResponse.json({
    key,
    encrypted,
    previouslySet: summary.previouslySet,
    // Echo back the masked or plain value so the UI can update without re-fetch.
    value: encrypted
      ? maskCredential(typeof validated === "string" ? validated : JSON.stringify(validated))
      : validated,
  })
}
