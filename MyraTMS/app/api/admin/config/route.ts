import { NextRequest, NextResponse } from "next/server"
import { withTenant } from "@/lib/db/tenant-context"
import { getCurrentUser, requireRole, requireTenantContext } from "@/lib/auth"
import { apiError } from "@/lib/api-error"
import { decrypt, maskCredential } from "@/lib/crypto/tenant-secrets"
import { DEFAULT_TENANT_CONFIG, SENSITIVE_CONFIG_KEYS } from "@/lib/tenants/defaults"

/**
 * GET /api/admin/config
 *
 * Returns every config key for the caller's tenant. Encrypted values are
 * decrypted server-side and then masked before being returned to the UI —
 * the API never returns plaintext credentials.
 *
 * Result shape:
 *   {
 *     tenantId: number,
 *     config: Array<{
 *       key: string,
 *       value: unknown,        // parsed JSON for plaintext, masked string for encrypted
 *       encrypted: boolean,
 *       hasValue: boolean,     // false for sensitive keys not yet set
 *       description: string,
 *       updatedAt: string | null,
 *       updatedBy: string | null,
 *     }>
 *   }
 */
export async function GET(req: NextRequest) {
  const user = getCurrentUser(req)
  if (!user) return apiError("Unauthorized", 401)

  const denied = requireRole(user, "admin", "owner", "service_admin")
  if (denied) return denied

  const ctx = requireTenantContext(req)

  const rows = await withTenant(ctx.tenantId, async (client) => {
    const { rows: configRows } = await client.query<{
      key: string
      value: string
      encrypted: boolean
      updated_at: string | null
      updated_by: string | null
    }>(
      `SELECT key, value, encrypted, updated_at, updated_by
         FROM tenant_config
        ORDER BY key`,
    )
    return configRows
  })

  // Build a unified view: every default key + every sensitive key, marking
  // those without a row as hasValue=false so the UI can render placeholders.
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const descriptionByKey = new Map(
    DEFAULT_TENANT_CONFIG.map((d) => [d.key, d.description] as const),
  )

  const allKeys = new Set<string>([
    ...DEFAULT_TENANT_CONFIG.map((d) => d.key),
    ...SENSITIVE_CONFIG_KEYS,
    ...rows.map((r) => r.key),
  ])

  const config = Array.from(allKeys)
    .sort()
    .map((key) => {
      const row = byKey.get(key)
      const isSensitive = (SENSITIVE_CONFIG_KEYS as ReadonlyArray<string>).includes(key)
      if (!row) {
        return {
          key,
          value: null,
          encrypted: isSensitive,
          hasValue: false,
          description: descriptionByKey.get(key) ?? "(sensitive credential — set during onboarding)",
          updatedAt: null,
          updatedBy: null,
        }
      }

      let displayValue: unknown
      if (row.encrypted) {
        try {
          displayValue = maskCredential(decrypt(row.value))
        } catch {
          // Decrypt failure (key rotation incomplete?) — surface as masked stub.
          displayValue = "***decrypt-error***"
        }
      } else {
        try {
          displayValue = JSON.parse(row.value)
        } catch {
          // Legacy/malformed plaintext — return raw string.
          displayValue = row.value
        }
      }

      return {
        key,
        value: displayValue,
        encrypted: row.encrypted,
        hasValue: true,
        description: descriptionByKey.get(key) ?? "",
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      }
    })

  return NextResponse.json({ tenantId: ctx.tenantId, config })
}
