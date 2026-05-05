// =============================================================================
// Tenant context wrapper for tenant-scoped database access.
//
// Spec: docs/architecture/ADR-001 §How Option A is implemented (item 4)
//       docs/architecture/SECURITY.md §2 (RLS), §4 (service-admin policy)
//
// Why this exists: every Cat A table has RLS policies that require
// `current_setting('app.current_tenant_id')` to be set in the current
// transaction. Setting it requires a persistent connection (HTTP-mode
// neon() opens a fresh connection per query, so SET LOCAL doesn't survive).
//
// Therefore: tenant-scoped queries use @neondatabase/serverless's Pool
// (WebSocket-based, persistent connection, supports transactions). The
// existing getDb() in lib/db.ts continues to serve unauthenticated paths
// (login, public tracking lookup) where no tenant context applies.
//
// Public API:
//   withTenant(tenantId, callback)   — opens tx, sets tenant context, runs callback
//   asServiceAdmin(reason, callback) — opens tx as service_admin, audits invocation
//   resolveTrackingToken(token)      — special case: token → tenant_id lookup
//
// Caller pattern:
//   await withTenant(req.tenant.id, async (client) => {
//     const result = await client.query('SELECT * FROM loads WHERE id = $1', [id])
//     return result.rows[0]
//   })
// =============================================================================

import { Pool, type PoolClient } from "@neondatabase/serverless"

/**
 * Thrown when withTenant() or asServiceAdmin() is called incorrectly:
 *   - Invalid tenantId (non-positive, non-finite, NaN)
 *   - Missing reason on asServiceAdmin
 *   - DB pool initialization failure
 */
export class TenantContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TenantContextError"
  }
}

let _pool: Pool | null = null

function getPool(): Pool {
  if (_pool) return _pool
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new TenantContextError("DATABASE_URL env var is not set")
  }
  _pool = new Pool({ connectionString: url })
  return _pool
}

/**
 * Test-only: closes the pool and clears the cache so a different
 * DATABASE_URL takes effect. Don't call from production code.
 */
export async function _resetPoolForTests(): Promise<void> {
  if (_pool) {
    await _pool.end()
    _pool = null
  }
}

/**
 * Run `callback` inside a transaction with the tenant context set.
 *
 * The transaction:
 *   1. BEGIN
 *   2. SET LOCAL app.current_tenant_id = '<tenantId>'
 *   3. await callback(client)  — RLS scoped to tenantId for all queries
 *   4. COMMIT (or ROLLBACK on throw)
 *
 * The PoolClient passed to the callback supports the standard pg-style API:
 *   client.query('SELECT * FROM loads WHERE id = $1', [id])
 *
 * If the callback throws, the transaction rolls back and the error
 * propagates. Connection is always released back to the pool.
 */
export async function withTenant<T>(
  tenantId: number,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(tenantId) || tenantId <= 0 || !Number.isInteger(tenantId)) {
    throw new TenantContextError(
      `withTenant: invalid tenantId ${String(tenantId)} — must be a positive integer`,
    )
  }
  const client = await getPool().connect()
  try {
    await client.query("BEGIN")
    // is_local=true scopes the setting to this transaction only
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [
      String(tenantId),
    ])
    const result = await callback(client)
    await client.query("COMMIT")
    return result
  } catch (err) {
    try {
      await client.query("ROLLBACK")
    } catch {
      // Best-effort rollback; surface the original error
    }
    throw err
  } finally {
    client.release()
  }
}

/**
 * Run `callback` inside a transaction with `app.role = 'service_admin'` set,
 * which triggers the service_admin_bypass RLS policy on every Cat A table.
 *
 * EVERY invocation is logged to tenant_audit_log with the reason. Per
 * SECURITY.md §4, this is the explicit escape hatch for cross-tenant
 * operations and should be used sparingly.
 *
 * `reason` is required and must be at least 5 characters — short reasons
 * make audit log forensics impossible.
 */
export async function asServiceAdmin<T>(
  reason: string,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (typeof reason !== "string" || reason.trim().length < 5) {
    throw new TenantContextError(
      "asServiceAdmin: reason required (min 5 chars)",
    )
  }
  const client = await getPool().connect()
  const startMs = Date.now()
  let result: T
  let queryCount = 0
  // Wrap query() to count invocations for audit payload
  const originalQuery = client.query.bind(client)
  // @ts-expect-error — assigning over the method to add counter
  client.query = (...args: Parameters<typeof originalQuery>) => {
    queryCount += 1
    return originalQuery(...args)
  }
  try {
    await originalQuery("BEGIN")
    await originalQuery(
      "SELECT set_config('app.role', 'service_admin', true)",
    )
    result = await callback(client)
    await originalQuery("COMMIT")
  } catch (err) {
    try {
      await originalQuery("ROLLBACK")
    } catch {}
    // Audit even on failure — failed escalations are still escalations
    await writeServiceAdminAudit(reason, queryCount, Date.now() - startMs, false).catch(
      () => {},
    )
    throw err
  } finally {
    client.release()
  }
  // Audit on success (separate connection — best-effort, doesn't block return)
  await writeServiceAdminAudit(reason, queryCount, Date.now() - startMs, true).catch(
    (auditErr: unknown) => {
      // Don't throw — audit failure should not break the operation
      // eslint-disable-next-line no-console
      console.error("Failed to write service_admin audit log:", auditErr)
    },
  )
  return result
}

async function writeServiceAdminAudit(
  reason: string,
  queryCount: number,
  durationMs: number,
  success: boolean,
): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.role', 'service_admin', true)")
    await client.query(
      `INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
       SELECT id, 'system:service_admin', 'service_admin_invocation', $1::jsonb
       FROM tenants WHERE slug = '_system'`,
      [
        JSON.stringify({
          reason,
          query_count: queryCount,
          duration_ms: durationMs,
          success,
        }),
      ],
    )
    await client.query("COMMIT")
  } catch (err) {
    try {
      await client.query("ROLLBACK")
    } catch {}
    throw err
  } finally {
    client.release()
  }
}

/**
 * Cron / batch helper: run `callback` once per active tenant, scoped via
 * withTenant() so RLS isolates each iteration.
 *
 * - Active = status IN ('active','trial') AND deleted_at IS NULL
 * - Skips the synthetic '_system' tenant (audit-only).
 * - Failures inside one tenant's callback DO NOT abort the run; they are
 *   captured and surfaced in the per-tenant results, so a single broken
 *   tenant cannot freeze a daily job for everyone else.
 *
 * Use from cron handlers:
 *   const summary = await forEachActiveTenant(
 *     'cron:invoice-alerts',
 *     async ({ tenantId, client }) => { ... per-tenant work ... },
 *   )
 */
export interface TenantIterationItem<T> {
  tenantId: number
  slug: string
  ok: boolean
  result?: T
  error?: string
}

export interface TenantIterationSummary<T> {
  totalTenants: number
  succeeded: number
  failed: number
  durationMs: number
  results: TenantIterationItem<T>[]
}

export async function forEachActiveTenant<T>(
  reason: string,
  callback: (args: { tenantId: number; slug: string; client: PoolClient }) => Promise<T>,
): Promise<TenantIterationSummary<T>> {
  const startMs = Date.now()
  const tenants = await asServiceAdmin(
    `${reason} — enumerate active tenants`,
    async (client) => {
      const { rows } = await client.query<{ id: number; slug: string }>(
        `SELECT id, slug
           FROM tenants
          WHERE deleted_at IS NULL
            AND status IN ('active', 'trial')
            AND slug <> '_system'
          ORDER BY id`,
      )
      return rows
    },
  )

  const results: TenantIterationItem<T>[] = []
  for (const t of tenants) {
    try {
      const result = await withTenant(Number(t.id), (client) =>
        callback({ tenantId: Number(t.id), slug: t.slug, client }),
      )
      results.push({ tenantId: Number(t.id), slug: t.slug, ok: true, result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.error(`[${reason}] tenant ${t.slug} (${t.id}) failed:`, msg)
      results.push({ tenantId: Number(t.id), slug: t.slug, ok: false, error: msg })
    }
  }

  return {
    totalTenants: tenants.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    durationMs: Date.now() - startMs,
    results,
  }
}

/**
 * Special case: resolve a public tracking token to its tenant_id.
 *
 * Public tracking URLs (/track/{64-char-hex}) bypass cookie auth and need to
 * look up the tenant via the token itself — chicken-and-egg per ADR-002 §3.
 * This is the ONE place where service_admin escalation happens automatically
 * (no human in the loop). Every call logs to tenant_audit_log with
 * event_type='tracking_token_resolution'.
 *
 * Returns: { tenantId, loadId } or null if token doesn't exist / expired.
 */
export async function resolveTrackingToken(
  token: string,
): Promise<{ tenantId: number; loadId: string } | null> {
  if (!token || typeof token !== "string" || token.length !== 64) {
    // Don't escalate for malformed tokens — just return null
    return null
  }
  const client = await getPool().connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.role', 'service_admin', true)")
    const { rows } = await client.query<{
      tenant_id: number
      load_id: string
    }>(
      `SELECT tenant_id, load_id
         FROM tracking_tokens
        WHERE token = $1
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [token],
    )
    // Audit the lookup with token prefix (NOT the full token — that's a credential)
    await client.query(
      `INSERT INTO tenant_audit_log (tenant_id, actor_user_id, event_type, event_payload)
       SELECT id, 'system:tracking', 'tracking_token_resolution', $1::jsonb
       FROM tenants WHERE slug = '_system'`,
      [
        JSON.stringify({
          token_prefix: token.slice(0, 8),
          resolved: rows.length > 0,
          resolved_tenant_id: rows[0]?.tenant_id ?? null,
          resolved_load_id: rows[0]?.load_id ?? null,
        }),
      ],
    )
    await client.query("COMMIT")
    if (rows.length === 0) return null
    return { tenantId: rows[0].tenant_id, loadId: rows[0].load_id }
  } catch (err) {
    try {
      await client.query("ROLLBACK")
    } catch {}
    throw err
  } finally {
    client.release()
  }
}
