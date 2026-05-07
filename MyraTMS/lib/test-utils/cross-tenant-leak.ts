// =============================================================================
// Cross-tenant leak audit helper.
//
// Spec: docs/architecture/RLS_ROLLOUT.md §pre-batch audit
//       docs/architecture/SESSION_3_SUMMARY.md §4 — smoke confirmation list
//
// Purpose: exercise a route or lib helper with two different tenant
// contexts and assert that the second never sees data created by the
// first. Used by Phase 7.1 leak audit before flipping ENABLE ROW LEVEL
// SECURITY in Phase M3.
//
// This is a TEST UTILITY, not production code. It opens its own DB
// transactions via withTenant — callers should use it in integration
// tests gated by RUN_INTEGRATION_TESTS=1, never in unit tests against
// mocked DBs.
//
// Pattern:
//   const result = await auditCrossTenantLeak({
//     tenantA: 2,
//     tenantB: 3,
//     setup:    (client) => client.query(`INSERT INTO loads ...`),
//     query:    (client) => client.query(`SELECT * FROM loads WHERE ...`),
//     teardown: (client) => client.query(`DELETE FROM loads ...`),
//   })
//   expect(result.leaked).toBe(false)
//   expect(result.tenantBSawCount).toBe(0)
// =============================================================================

import { withTenant } from "@/lib/db/tenant-context"
import type { PoolClient } from "@neondatabase/serverless"

export interface CrossTenantLeakAudit<T> {
  /** Tenant id that creates the data. */
  tenantA: number
  /** Tenant id that should NOT see the data. */
  tenantB: number
  /** Optional setup query under tenantA's RLS context. */
  setup?: (client: PoolClient) => Promise<void>
  /** Read query — runs in BOTH tenant contexts; results are compared. */
  query: (client: PoolClient) => Promise<{ rows: T[] }>
  /** Optional teardown query under tenantA's context. */
  teardown?: (client: PoolClient) => Promise<void>
}

export interface CrossTenantLeakResult<T> {
  /** Number of rows tenantA's read returned. */
  tenantASawCount: number
  /** Number of rows tenantB's read returned — must be 0 if no leak. */
  tenantBSawCount: number
  /** Convenience flag: true when tenantBSawCount > 0. */
  leaked: boolean
  /** The actual rows tenantB saw — included in the result so a failing test can log them. */
  tenantBLeakedRows: T[]
  /** Tenant A's row count for sanity (you should usually expect this > 0). */
  tenantASawRows: T[]
}

/**
 * Run the same SELECT query against the same DB under two different
 * tenant contexts and report whether tenantB saw any of tenantA's rows.
 *
 * Invariants this helper enforces:
 *   - Setup runs ONLY under tenantA (not under tenantB)
 *   - Each read uses its own withTenant() transaction (so RLS context
 *     setting is fresh, not leaked from a prior call)
 *   - Teardown ALWAYS runs even if reads throw, in tenantA's context
 *   - Returns a structured result rather than throwing on leak — the
 *     caller's expect() decides the fail condition
 */
export async function auditCrossTenantLeak<T>(
  args: CrossTenantLeakAudit<T>,
): Promise<CrossTenantLeakResult<T>> {
  const { tenantA, tenantB, setup, query, teardown } = args

  if (tenantA === tenantB) {
    throw new Error(
      `auditCrossTenantLeak: tenantA and tenantB must differ (both = ${tenantA})`,
    )
  }

  let tenantASawRows: T[] = []
  let tenantBLeakedRows: T[] = []

  try {
    // 1. Set up data under tenantA's context.
    if (setup) {
      await withTenant(tenantA, async (client) => {
        await setup(client)
      })
    }

    // 2. Read under tenantA's context — sanity check that the data exists.
    await withTenant(tenantA, async (client) => {
      const { rows } = await query(client)
      tenantASawRows = rows
    })

    // 3. Read under tenantB's context — this is THE leak check.
    await withTenant(tenantB, async (client) => {
      const { rows } = await query(client)
      tenantBLeakedRows = rows
    })
  } finally {
    // 4. Teardown ALWAYS runs under tenantA, even if reads threw.
    if (teardown) {
      try {
        await withTenant(tenantA, async (client) => {
          await teardown(client)
        })
      } catch (err) {
        // Don't mask the original error if there was one. Best-effort cleanup.
        // eslint-disable-next-line no-console
        console.error(
          `[cross-tenant-leak] teardown failed (tenantA=${tenantA}):`,
          err,
        )
      }
    }
  }

  return {
    tenantASawCount: tenantASawRows.length,
    tenantBSawCount: tenantBLeakedRows.length,
    leaked: tenantBLeakedRows.length > 0,
    tenantASawRows,
    tenantBLeakedRows,
  }
}

/**
 * Multi-table sweep — run auditCrossTenantLeak across every table in a
 * list and aggregate. Used by the Phase 7.1 audit to walk every Cat A
 * table once.
 *
 * Each entry's setup/query/teardown are independent — failure in one
 * table's audit does NOT short-circuit the rest. The aggregate result
 * tells the caller exactly which tables (if any) leaked.
 */
export async function auditAllCrossTenantLeaks(
  tenantA: number,
  tenantB: number,
  audits: Array<
    Omit<CrossTenantLeakAudit<unknown>, "tenantA" | "tenantB"> & {
      tableName: string
    }
  >,
): Promise<{
  totalTables: number
  leakedTables: string[]
  perTable: Array<{
    tableName: string
    leaked: boolean
    tenantASawCount: number
    tenantBSawCount: number
    error?: string
  }>
}> {
  const perTable: Array<{
    tableName: string
    leaked: boolean
    tenantASawCount: number
    tenantBSawCount: number
    error?: string
  }> = []

  for (const audit of audits) {
    try {
      const result = await auditCrossTenantLeak({
        tenantA,
        tenantB,
        setup: audit.setup,
        query: audit.query,
        teardown: audit.teardown,
      })
      perTable.push({
        tableName: audit.tableName,
        leaked: result.leaked,
        tenantASawCount: result.tenantASawCount,
        tenantBSawCount: result.tenantBSawCount,
      })
    } catch (err) {
      perTable.push({
        tableName: audit.tableName,
        leaked: false, // unknown — error rather than confirmed leak
        tenantASawCount: -1,
        tenantBSawCount: -1,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const leakedTables = perTable
    .filter((r) => r.leaked)
    .map((r) => r.tableName)

  return {
    totalTables: audits.length,
    leakedTables,
    perTable,
  }
}
