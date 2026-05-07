import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Unit tests for lib/test-utils/cross-tenant-leak.ts
//
// We mock @/lib/db/tenant-context so the helper can be exercised without
// a real Postgres. The mock provides a withTenant that simulates RLS
// scoping by tagging client.query results with the tenant id passed in,
// so we can verify:
//   - tenantA's setup runs under tenantA
//   - tenantB sees only the rows it queries (no leak in the simulation)
//   - teardown ALWAYS runs under tenantA, even if reads throw
//   - argument validation (tenantA === tenantB) rejects
// ---------------------------------------------------------------------------

interface MockClient {
  query: ReturnType<typeof vi.fn>
  __tenant: number
}

// Vitest hoists vi.mock() factories above top-level consts. The vi.hoisted
// pattern lets us share the mock fn between the factory and the test body.
const { mockWithTenant } = vi.hoisted(() => ({
  mockWithTenant: vi.fn(
    async (tenantId: number, cb: (client: MockClient) => Promise<unknown>) => {
      const client: MockClient = { query: vi.fn(), __tenant: tenantId }
      return cb(client)
    },
  ),
}))

vi.mock("@/lib/db/tenant-context", () => ({
  withTenant: mockWithTenant,
}))

import {
  auditCrossTenantLeak,
  auditAllCrossTenantLeaks,
} from "@/lib/test-utils/cross-tenant-leak"

beforeEach(() => {
  mockWithTenant.mockClear()
})

describe("auditCrossTenantLeak — argument validation", () => {
  it("rejects when tenantA equals tenantB", async () => {
    await expect(
      auditCrossTenantLeak({
        tenantA: 2,
        tenantB: 2,
        query: async () => ({ rows: [] }),
      }),
    ).rejects.toThrow(/must differ/)
  })
})

describe("auditCrossTenantLeak — call routing", () => {
  it("setup runs only under tenantA", async () => {
    const setup = vi.fn(async () => undefined)
    await auditCrossTenantLeak({
      tenantA: 2,
      tenantB: 3,
      setup,
      query: async () => ({ rows: [] }),
    })
    // setup is called from within the mock withTenant invocation; check
    // that the underlying withTenant was called with tenantA=2 first.
    // Total withTenant invocations: setup(2), readA(2), readB(3) = 3.
    expect(mockWithTenant).toHaveBeenCalledTimes(3)
    expect(mockWithTenant.mock.calls[0][0]).toBe(2)
    expect(mockWithTenant.mock.calls[1][0]).toBe(2)
    expect(mockWithTenant.mock.calls[2][0]).toBe(3)
    expect(setup).toHaveBeenCalledTimes(1)
  })

  it("teardown runs even when read query throws", async () => {
    const teardown = vi.fn(async () => undefined)
    const failingQuery = vi.fn(async () => {
      throw new Error("simulated DB error")
    })

    await expect(
      auditCrossTenantLeak({
        tenantA: 2,
        tenantB: 3,
        query: failingQuery,
        teardown,
      }),
    ).rejects.toThrow(/simulated DB error/)

    expect(teardown).toHaveBeenCalledTimes(1)
    // Teardown call is the LAST withTenant invocation, in tenantA's context.
    const lastCall = mockWithTenant.mock.calls.at(-1)
    expect(lastCall?.[0]).toBe(2)
  })

  it("teardown failure is swallowed and logged, original result returns", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const teardown = vi.fn(async () => {
      throw new Error("teardown failed")
    })

    // Read returns rows — happy path on the read, but teardown blows up.
    const result = await auditCrossTenantLeak({
      tenantA: 2,
      tenantB: 3,
      query: async () => ({ rows: [] }),
      teardown,
    })

    expect(result.leaked).toBe(false)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})

describe("auditCrossTenantLeak — leak detection result shape", () => {
  it("flags leaked=false when tenantB sees zero rows", async () => {
    // Read returns no rows → no leak.
    const result = await auditCrossTenantLeak({
      tenantA: 2,
      tenantB: 3,
      query: async () => ({ rows: [] }),
    })
    expect(result.tenantASawCount).toBe(0)
    expect(result.tenantBSawCount).toBe(0)
    expect(result.leaked).toBe(false)
    expect(result.tenantBLeakedRows).toEqual([])
  })

  it("flags leaked=true when tenantB sees any rows", async () => {
    // Read returns the same rows for both contexts — simulates a leak
    // (the real world should NEVER have this; the test asserts that
    // the helper flags it correctly when it does happen).
    const sharedRows = [{ id: "row-1" }, { id: "row-2" }]
    const result = await auditCrossTenantLeak<{ id: string }>({
      tenantA: 2,
      tenantB: 3,
      query: async () => ({ rows: sharedRows }),
    })
    expect(result.tenantASawCount).toBe(2)
    expect(result.tenantBSawCount).toBe(2)
    expect(result.leaked).toBe(true)
    expect(result.tenantBLeakedRows).toEqual(sharedRows)
  })

  it("differentiates per-tenant reads when query branches on client", async () => {
    // Realistic case: simulate RLS by checking the mock client's __tenant.
    const result = await auditCrossTenantLeak<{ id: string }>({
      tenantA: 2,
      tenantB: 3,
      query: async (client) => {
        const c = client as unknown as MockClient
        return c.__tenant === 2
          ? { rows: [{ id: "tenant-2-row" }] }
          : { rows: [] }
      },
    })
    expect(result.tenantASawCount).toBe(1)
    expect(result.tenantBSawCount).toBe(0)
    expect(result.leaked).toBe(false)
  })
})

describe("auditAllCrossTenantLeaks — multi-table sweep", () => {
  it("aggregates per-table results", async () => {
    const result = await auditAllCrossTenantLeaks(2, 3, [
      {
        tableName: "loads",
        query: async (client) => {
          const c = client as unknown as MockClient
          return c.__tenant === 2 ? { rows: [{ id: "L-1" }] } : { rows: [] }
        },
      },
      {
        tableName: "carriers",
        query: async (client) => {
          const c = client as unknown as MockClient
          return c.__tenant === 2 ? { rows: [{ id: "C-1" }] } : { rows: [] }
        },
      },
    ])
    expect(result.totalTables).toBe(2)
    expect(result.leakedTables).toEqual([])
    expect(result.perTable.every((t) => t.leaked === false)).toBe(true)
  })

  it("flags only leaked tables in leakedTables", async () => {
    const sharedRow = { id: "should-not-leak" }
    const result = await auditAllCrossTenantLeaks(2, 3, [
      {
        tableName: "good_table",
        query: async (client) => {
          const c = client as unknown as MockClient
          return c.__tenant === 2 ? { rows: [{ id: "G-1" }] } : { rows: [] }
        },
      },
      {
        tableName: "leaky_table",
        // Returns rows for BOTH tenant contexts — simulates a leak.
        query: async () => ({ rows: [sharedRow] }),
      },
    ])
    expect(result.leakedTables).toEqual(["leaky_table"])
    expect(result.perTable.find((t) => t.tableName === "leaky_table")?.leaked).toBe(true)
    expect(result.perTable.find((t) => t.tableName === "good_table")?.leaked).toBe(false)
  })

  it("captures errors per-table without short-circuiting", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const result = await auditAllCrossTenantLeaks(2, 3, [
      {
        tableName: "broken_table",
        query: async () => {
          throw new Error("boom")
        },
      },
      {
        tableName: "ok_table",
        query: async () => ({ rows: [] }),
      },
    ])
    expect(result.totalTables).toBe(2)
    expect(result.perTable.find((t) => t.tableName === "broken_table")?.error).toMatch(
      /boom/,
    )
    expect(result.perTable.find((t) => t.tableName === "ok_table")?.leaked).toBe(false)
    errorSpy.mockRestore()
  })
})
