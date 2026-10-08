// =============================================================================
// Production-database guard for the test runner.
//
// Why: `MyraTMS/.env.local`'s DATABASE_URL has pointed at the production Neon
// branch, and most Engine 2/3 tests INSERT/DELETE real rows. This module makes
// that impossible by accident: when code runs under vitest (or any process that
// sets ALLOW_PROD_TESTS-aware NODE_ENV=test) and the connection string targets
// production, every DB client factory throws before opening a connection.
//
// Escape hatch: ALLOW_PROD_TESTS=1 — for the documented "re-run this module's
// tests directly against production after apply" step, and nothing else.
//
// Identifiers are matched on the connection string itself. Neon URLs carry the
// compute endpoint id (ep-…), never the branch id (br-…), so both are listed:
// the endpoint is what actually matches today; the branch id is kept so a
// future pooled/branch-style URL is still caught.
//
// Wired into: vitest.setup.ts (fail-fast, once per worker), lib/db.ts,
// lib/db/tenant-context.ts, lib/pipeline/db-adapter.ts (belt-and-braces, in
// case a test bypasses the vitest config).
// =============================================================================

/** Production Neon branch + its read-write endpoint (project lingering-bar-21372774). */
export const PRODUCTION_DB_IDENTIFIERS = [
  "br-rough-forest-aif4a3vf",
  "ep-lively-shadow-aibzw8bp",
] as const

export class ProductionDatabaseGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProductionDatabaseGuardError"
  }
}

/** True when the connection string targets the production branch. */
export function isProductionDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false
  return PRODUCTION_DB_IDENTIFIERS.some((id) => url.includes(id))
}

/** True when running under vitest or NODE_ENV=test. */
export function isTestRuntime(): boolean {
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test"
}

/**
 * Throw if a test process is about to open a connection to production.
 * No-op outside test runtimes (Next.js, Railway workers) and when
 * ALLOW_PROD_TESTS=1 is set explicitly.
 */
export function assertNotProductionUnderTest(url: string | undefined): void {
  if (!isTestRuntime()) return
  if (process.env.ALLOW_PROD_TESTS === "1") return
  if (!isProductionDatabaseUrl(url)) return
  throw new ProductionDatabaseGuardError(
    "Refusing to run tests against the PRODUCTION Neon branch " +
      "(DATABASE_URL matches br-rough-forest-aif4a3vf / ep-lively-shadow-aibzw8bp). " +
      "Point DATABASE_URL at a dev/verify branch, or set ALLOW_PROD_TESTS=1 " +
      "only for an explicitly-confirmed post-apply verification run.",
  )
}
