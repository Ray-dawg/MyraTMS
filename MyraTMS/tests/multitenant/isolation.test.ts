// =============================================================================
// Multi-tenant isolation integration test suite.
//
// Spec: mega-mission Task 1.6 + ADR-001 §Validation #2.
// Scope: verifies that withTenant() and the RLS policies (when enabled)
//        properly scope every read/write to the tenant context.
//
// REQUIREMENTS to run:
//   - DATABASE_URL points at a Neon staging branch (NEVER prod)
//   - MYRA_TENANT_CONFIG_KEY env var set
//   - Migrations 027, 028, 029 applied
//   - RLS NOT YET ENABLED on the tables (this suite verifies behavior with
//     policies CREATE'd-but-disabled, which is the post-029 / pre-M3 state)
//
// HOW TO ENABLE RLS-ENABLED VARIANT:
//   - Set TEST_RLS_ENABLED=1 — the suite ALSO runs assertions that would
//     only pass if RLS is active. Used by Phase M3 per-batch validation.
//
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { Pool, type PoolClient } from "@neondatabase/serverless"
import {
  withTenant,
  asServiceAdmin,
  resolveTrackingToken,
  TenantContextError,
  _resetPoolForTests,
} from "@/lib/db/tenant-context"

const RLS_ENABLED = process.env.TEST_RLS_ENABLED === "1"

let adminPool: Pool

// Two test tenants we provision and tear down per suite run.
let tenantA: number = 0
let tenantB: number = 0

// Skip the entire suite if no DATABASE_URL — protects local `pnpm test` from
// hammering whatever the developer happens to have in their shell env.
const isStagingDb = !!process.env.DATABASE_URL && !!process.env.RUN_INTEGRATION_TESTS

describe.skipIf(!isStagingDb)("multi-tenant isolation", () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.DATABASE_URL })

    // Provision two test tenants via service_admin escalation
    await asServiceAdmin("integration test setup", async (client) => {
      // Use timestamp suffixes so reruns don't collide
      const suffix = Date.now().toString(36)
      const { rows: [a] } = await client.query<{ id: number }>(
        `INSERT INTO tenants (slug, name, type, status)
         VALUES ($1, $2, 'saas_customer', 'active')
         RETURNING id`,
        [`test-a-${suffix}`, `Test Tenant A ${suffix}`],
      )
      const { rows: [b] } = await client.query<{ id: number }>(
        `INSERT INTO tenants (slug, name, type, status)
         VALUES ($1, $2, 'saas_customer', 'active')
         RETURNING id`,
        [`test-b-${suffix}`, `Test Tenant B ${suffix}`],
      )
      tenantA = a.id
      tenantB = b.id
      // Subscriptions
      await client.query(
        `INSERT INTO tenant_subscriptions (tenant_id, tier, status)
         VALUES ($1, 'starter', 'active'), ($2, 'starter', 'active')`,
        [tenantA, tenantB],
      )
    })
  })

  afterAll(async () => {
    if (tenantA && tenantB) {
      await asServiceAdmin("integration test teardown", async (client) => {
        // Cascade drops everything tenant-scoped
        await client.query("DELETE FROM tenants WHERE id IN ($1, $2)", [
          tenantA,
          tenantB,
        ])
      })
    }
    await adminPool?.end()
    await _resetPoolForTests()
  })

  beforeEach(async () => {
    // Clear any tenant-A/B fixtures from prior tests in this suite
    await asServiceAdmin("test isolation cleanup", async (client) => {
      await client.query(
        `DELETE FROM shippers WHERE tenant_id IN ($1, $2) AND id LIKE 'TEST-%'`,
        [tenantA, tenantB],
      )
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 1 — two tenants, identical data, zero crossing
  // ─────────────────────────────────────────────────────────────────────
  describe("Scenario 1 — identical data, zero crossing", () => {
    it("each tenant sees only its own rows", async () => {
      // Insert identically-shaped rows into each tenant
      await withTenant(tenantA, async (client) => {
        await client.query(
          `INSERT INTO shippers (id, company, contact_email, tenant_id)
           VALUES ('TEST-A-1', 'Acme', 'a1@example.com', $1)`,
          [tenantA],
        )
      })
      await withTenant(tenantB, async (client) => {
        await client.query(
          `INSERT INTO shippers (id, company, contact_email, tenant_id)
           VALUES ('TEST-B-1', 'Acme', 'a1@example.com', $1)`,
          [tenantB],
        )
      })

      // Read from tenant A — should see only TEST-A-1 (when RLS enabled)
      // OR see both (when RLS disabled, application provides filter)
      const aRows = await withTenant(tenantA, async (client) => {
        if (RLS_ENABLED) {
          // RLS scopes — no WHERE clause needed
          const { rows } = await client.query<{ id: string }>(
            `SELECT id FROM shippers WHERE id LIKE 'TEST-%'`,
          )
          return rows
        }
        // Pre-RLS: application must provide the filter explicitly
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM shippers WHERE tenant_id = $1 AND id LIKE 'TEST-%'`,
          [tenantA],
        )
        return rows
      })
      expect(aRows.map((r) => r.id)).toEqual(["TEST-A-1"])

      const bRows = await withTenant(tenantB, async (client) => {
        if (RLS_ENABLED) {
          const { rows } = await client.query<{ id: string }>(
            `SELECT id FROM shippers WHERE id LIKE 'TEST-%'`,
          )
          return rows
        }
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM shippers WHERE tenant_id = $1 AND id LIKE 'TEST-%'`,
          [tenantB],
        )
        return rows
      })
      expect(bRows.map((r) => r.id)).toEqual(["TEST-B-1"])
    })

    it("inserts in tenant A are not visible in tenant B context", async () => {
      const carrierId = `TEST-CAR-${Date.now()}`
      await withTenant(tenantA, async (client) => {
        await client.query(
          `INSERT INTO carriers (id, company, mc_number, tenant_id)
           VALUES ($1, 'Test Carrier', 'MC-999000', $2)`,
          [carrierId, tenantA],
        )
      })
      const bSee = await withTenant(tenantB, async (client) => {
        const { rows } = await client.query(
          `SELECT id FROM carriers WHERE id = $1${RLS_ENABLED ? "" : " AND tenant_id = $2"}`,
          RLS_ENABLED ? [carrierId] : [carrierId, tenantB],
        )
        return rows.length
      })
      expect(bSee).toBe(0)

      // Cleanup
      await asServiceAdmin("test cleanup", async (client) => {
        await client.query("DELETE FROM carriers WHERE id = $1", [carrierId])
      })
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 2 — same MC number across tenants is allowed
  // ─────────────────────────────────────────────────────────────────────
  describe("Scenario 2 — per-tenant uniqueness", () => {
    it("two tenants can both have a carrier with mc_number MC-12345", async () => {
      const tsA = `TEST-CA-${Date.now()}-A`
      const tsB = `TEST-CB-${Date.now()}-B`

      await withTenant(tenantA, async (client) => {
        await client.query(
          `INSERT INTO carriers (id, company, mc_number, tenant_id)
           VALUES ($1, 'A version', 'MC-12345', $2)`,
          [tsA, tenantA],
        )
      })
      // Same MC in tenant B should NOT collide (idx_carriers_tenant_mc is composite)
      await expect(
        withTenant(tenantB, async (client) => {
          await client.query(
            `INSERT INTO carriers (id, company, mc_number, tenant_id)
             VALUES ($1, 'B version', 'MC-12345', $2)`,
            [tsB, tenantB],
          )
        }),
      ).resolves.not.toThrow()

      // But same MC twice in tenant A SHOULD collide
      await expect(
        withTenant(tenantA, async (client) => {
          await client.query(
            `INSERT INTO carriers (id, company, mc_number, tenant_id)
             VALUES ('TEST-CA-DUP', 'A duplicate', 'MC-12345', $1)`,
            [tenantA],
          )
        }),
      ).rejects.toThrow(/unique|duplicate/i)

      // Cleanup
      await asServiceAdmin("test cleanup", async (client) => {
        await client.query("DELETE FROM carriers WHERE id IN ($1, $2)", [tsA, tsB])
      })
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 3 — invalid tenant context throws
  // ─────────────────────────────────────────────────────────────────────
  describe("Scenario 3 — context validation", () => {
    it("withTenant rejects negative tenant id", async () => {
      await expect(
        withTenant(-1, async () => "noop"),
      ).rejects.toThrow(TenantContextError)
    })

    it("withTenant rejects zero tenant id", async () => {
      await expect(
        withTenant(0, async () => "noop"),
      ).rejects.toThrow(TenantContextError)
    })

    it("withTenant rejects non-integer tenant id", async () => {
      await expect(
        withTenant(1.5, async () => "noop"),
      ).rejects.toThrow(TenantContextError)
    })

    it("withTenant rejects NaN tenant id", async () => {
      await expect(
        withTenant(NaN, async () => "noop"),
      ).rejects.toThrow(TenantContextError)
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 4 — service_admin bypass works (cross-tenant query) AND audits
  // ─────────────────────────────────────────────────────────────────────
  describe("Scenario 4 — service_admin escalation", () => {
    it("asServiceAdmin can query both tenants in one transaction", async () => {
      const result = await asServiceAdmin(
        "cross-tenant analytics test",
        async (client) => {
          const { rows } = await client.query<{ tenant_id: number; n: number }>(
            `SELECT tenant_id, COUNT(*)::int AS n
               FROM tenants
              WHERE id IN ($1, $2)
              GROUP BY tenant_id`,
            [tenantA, tenantB],
          )
          return rows
        },
      )
      expect(result.length).toBeGreaterThanOrEqual(2)
    })

    it("asServiceAdmin invocation is recorded in tenant_audit_log", async () => {
      const reason = `audit log test ${Date.now()}`
      await asServiceAdmin(reason, async () => "ok")

      // Read the audit log via service_admin (we can't query as a tenant
      // because the audit log row is owned by _system tenant)
      const found = await asServiceAdmin("verify audit", async (client) => {
        const { rows } = await client.query<{ event_payload: { reason: string } }>(
          `SELECT event_payload FROM tenant_audit_log
           WHERE event_type = 'service_admin_invocation'
             AND created_at > NOW() - INTERVAL '5 seconds'
           ORDER BY id DESC LIMIT 10`,
        )
        return rows.some((r) => r.event_payload?.reason === reason)
      })
      expect(found).toBe(true)
    })

    it("asServiceAdmin rejects empty reason", async () => {
      await expect(asServiceAdmin("", async () => "noop")).rejects.toThrow(
        TenantContextError,
      )
    })

    it("asServiceAdmin rejects too-short reason", async () => {
      await expect(asServiceAdmin("a", async () => "noop")).rejects.toThrow(
        TenantContextError,
      )
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 5 — tracking token resolution
  // ─────────────────────────────────────────────────────────────────────
  describe("Scenario 5 — tracking token resolution", () => {
    it("returns null for malformed token", async () => {
      expect(await resolveTrackingToken("")).toBeNull()
      expect(await resolveTrackingToken("too-short")).toBeNull()
      expect(await resolveTrackingToken("x".repeat(63))).toBeNull()
      expect(await resolveTrackingToken("x".repeat(65))).toBeNull()
    })

    it("returns null for non-existent token", async () => {
      const fakeToken = "0".repeat(64)
      expect(await resolveTrackingToken(fakeToken)).toBeNull()
    })

    it("resolves an existing token to its tenant_id and load_id", async () => {
      const loadId = `TEST-LD-${Date.now()}`
      const token = "f".repeat(64)
      await withTenant(tenantA, async (client) => {
        await client.query(
          `INSERT INTO loads (id, origin, destination, tenant_id, status)
           VALUES ($1, 'Toronto', 'Sudbury', $2, 'Booked')`,
          [loadId, tenantA],
        )
        await client.query(
          `INSERT INTO tracking_tokens (load_id, token, tenant_id)
           VALUES ($1, $2, $3)`,
          [loadId, token, tenantA],
        )
      })

      const resolved = await resolveTrackingToken(token)
      expect(resolved).toEqual({ tenantId: tenantA, loadId })

      // Cleanup
      await asServiceAdmin("test cleanup", async (client) => {
        await client.query("DELETE FROM tracking_tokens WHERE token = $1", [token])
        await client.query("DELETE FROM loads WHERE id = $1", [loadId])
      })
    })

    it("token resolution is recorded in tenant_audit_log", async () => {
      const loadId = `TEST-LD-${Date.now()}-AUD`
      const token = "e".repeat(64)
      await withTenant(tenantA, async (client) => {
        await client.query(
          `INSERT INTO loads (id, origin, destination, tenant_id)
           VALUES ($1, 'A', 'B', $2)`,
          [loadId, tenantA],
        )
        await client.query(
          `INSERT INTO tracking_tokens (load_id, token, tenant_id)
           VALUES ($1, $2, $3)`,
          [loadId, token, tenantA],
        )
      })
      await resolveTrackingToken(token)

      const audited = await asServiceAdmin("verify audit", async (client) => {
        const { rows } = await client.query<{ event_payload: { token_prefix: string } }>(
          `SELECT event_payload FROM tenant_audit_log
           WHERE event_type = 'tracking_token_resolution'
             AND created_at > NOW() - INTERVAL '5 seconds'
           ORDER BY id DESC LIMIT 10`,
        )
        return rows.some((r) => r.event_payload?.token_prefix === token.slice(0, 8))
      })
      expect(audited).toBe(true)

      // Cleanup
      await asServiceAdmin("test cleanup", async (client) => {
        await client.query("DELETE FROM tracking_tokens WHERE token = $1", [token])
        await client.query("DELETE FROM loads WHERE id = $1", [loadId])
      })
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 6 — RLS-only assertions (skipped unless TEST_RLS_ENABLED=1)
  // ─────────────────────────────────────────────────────────────────────
  describe.skipIf(!RLS_ENABLED)("Scenario 6 — RLS enforcement", () => {
    it("query without tenant context returns 0 rows under RLS", async () => {
      // Use the admin pool directly (NOT through withTenant) — no context set
      const client = await adminPool.connect()
      try {
        const { rows } = await client.query("SELECT id FROM shippers LIMIT 1")
        expect(rows).toEqual([])
      } finally {
        client.release()
      }
    })

    it("INSERT without tenant context fails under RLS", async () => {
      const client = await adminPool.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO shippers (id, company) VALUES ('TEST-NOCTX', 'X')`,
          ),
        ).rejects.toThrow()
      } finally {
        client.release()
      }
    })

    it("transaction with set_config but no tenant returns 0 rows", async () => {
      const client = await adminPool.connect()
      try {
        await client.query("BEGIN")
        // Set a non-existent tenant id
        await client.query(
          "SELECT set_config('app.current_tenant_id', '999999', true)",
        )
        const { rows } = await client.query("SELECT id FROM shippers LIMIT 1")
        expect(rows).toEqual([])
        await client.query("ROLLBACK")
      } finally {
        client.release()
      }
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Vitest config note: this suite uses describe.skipIf(!isStagingDb) so it
// never runs on a developer's local machine without explicit opt-in via
// RUN_INTEGRATION_TESTS=1. Add the same gate to vitest.config.ts if needed.
// ─────────────────────────────────────────────────────────────────────────
