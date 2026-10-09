// __tests__/documents/driver-scoping.test.ts
//
// Pins FINDING 1 of the 2026-10-08 round-3 middleware review.
//
// middleware.ts grants a driver JWT exact-match access to GET /api/documents
// because DApp/components/docs-screen.tsx:81 fetches
// `/api/documents?relatedType=Load`. That query supplies relatedType but NOT
// relatedTo, and the handler's first branch requires BOTH -- so a driver token
// fell through to a bare `SELECT * FROM documents ORDER BY created_at DESC`
// and received the whole tenant's document set: carrier rate confirmations,
// invoices, signed shipper rate-cons. The handler has no role check at all, so
// middleware's path allowlist was acting as a row-level boundary, which it is
// not.
//
// The assertions below are on the SQL the handler builds, because that is
// where the authorization decision now lives. Against the pre-fix handler the
// driver cases all see an unfiltered statement and fail.
//
// Schema facts the filter rests on (verified, not assumed):
//   loads.driver_id UUID REFERENCES drivers(id)   scripts/010-m1-migration.sql:128
//   documents.related_type IN ('Load','Shipper','Carrier')
//   documents.related_to = loads.id for Load docs  scripts/001-create-tables.sql:106-107
//   a driver JWT's userId claim IS drivers.id      app/api/auth/driver-login/route.ts:56-64

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const queryMock = vi.fn()

vi.mock("@/lib/db/tenant-context", () => ({
  withTenant: async (_tenantId: number, fn: (client: unknown) => unknown) =>
    fn({ query: (...args: unknown[]) => queryMock(...args) }),
}))

const ctxMock = vi.fn()
vi.mock("@/lib/auth", () => ({
  requireTenantContext: (...args: unknown[]) => ctxMock(...args),
}))

import { GET } from "@/app/api/documents/route"

const DRIVER_UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"

/** A driver principal, as lib/auth.ts getTenantContext() now derives it. */
const driverCtx = (userId: string = DRIVER_UUID) => ({
  tenantId: 2,
  role: "driver",
  userId,
  isSuperAdmin: false,
})

const brokerCtx = () => ({
  tenantId: 2,
  role: "admin",
  userId: "usr-1",
  isSuperAdmin: false,
})

function req(qs = ""): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000/api/documents${qs}`))
}

/** Collapse whitespace so assertions do not depend on template indentation. */
function sqlOf(call: number): string {
  return String(queryMock.mock.calls[call][0]).replace(/\s+/g, " ").trim()
}

function paramsOf(call: number): unknown[] {
  return queryMock.mock.calls[call][1] as unknown[]
}

beforeEach(() => {
  queryMock.mockReset()
  ctxMock.mockReset()
  queryMock.mockResolvedValue({ rows: [] })
})

describe("GET /api/documents driver scoping", () => {
  // The exact call the DApp Docs tab makes. This is the one that leaked.
  it("scopes the DApp Docs-tab query (?relatedType=Load) to the driver's own loads", async () => {
    ctxMock.mockReturnValue(driverCtx())
    const res = await GET(req("?relatedType=Load"))

    expect(res.status).toBe(200)
    const sql = sqlOf(0)
    expect(
      sql,
      "driver received an unfiltered SELECT over the whole tenant's documents",
    ).toContain("WHERE related_type = 'Load'")
    expect(sql).toContain("related_to IN (SELECT id FROM loads WHERE driver_id = $1::uuid)")
    expect(paramsOf(0)).toEqual([DRIVER_UUID])
  })

  it("never emits an unfiltered documents SELECT for a driver, on any query shape", async () => {
    ctxMock.mockReturnValue(driverCtx())
    for (const qs of ["", "?relatedType=Load", "?relatedType=Carrier", "?search=rate", "?relatedTo=LD-1&relatedType=Load"]) {
      queryMock.mockClear()
      await GET(req(qs))
      // Some shapes may short-circuit without a query; any query that IS run
      // must carry the driver scope.
      for (let i = 0; i < queryMock.mock.calls.length; i++) {
        expect(sqlOf(i), `query for "${qs}" is not driver-scoped`).toContain(
          "driver_id = $",
        )
      }
    }
  })

  it("intersects the driver scope with an explicit relatedTo/relatedType pair", async () => {
    ctxMock.mockReturnValue(driverCtx())
    await GET(req("?relatedTo=LD-ABC123&relatedType=Load"))

    const sql = sqlOf(0)
    expect(sql).toContain("WHERE related_to = $1 AND related_type = $2")
    expect(sql).toContain("AND related_type = 'Load'")
    expect(sql).toContain("driver_id = $3::uuid")
    expect(paramsOf(0)).toEqual(["LD-ABC123", "Load", DRIVER_UUID])
  })

  it("parenthesises the search OR so the driver scope cannot be short-circuited", async () => {
    ctxMock.mockReturnValue(driverCtx())
    await GET(req("?search=rate"))

    const sql = sqlOf(0)
    // Without the parens, AND binds tighter than OR and `name ILIKE $1` alone
    // would satisfy the WHERE clause, leaking every document whose NAME
    // matched regardless of which load it belongs to.
    expect(sql).toContain("WHERE (name ILIKE $1 OR related_to ILIKE $1)")
    expect(sql).toContain("driver_id = $2::uuid")
    expect(paramsOf(0)).toEqual(["%rate%", DRIVER_UUID])
  })

  it("fails closed for a driver whose userId is not a drivers.id UUID", async () => {
    ctxMock.mockReturnValue(driverCtx("not-a-uuid"))
    const res = await GET(req("?relatedType=Load"))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    // No unscoped fallback query, and nothing reaches the ::uuid cast.
    expect(queryMock).not.toHaveBeenCalled()
  })
})

describe("GET /api/documents non-driver behaviour is unchanged", () => {
  it("runs the same unfiltered list query for a broker role", async () => {
    ctxMock.mockReturnValue(brokerCtx())
    await GET(req())

    const sql = sqlOf(0)
    expect(sql).toBe("SELECT * FROM documents ORDER BY created_at DESC")
    // Byte-identical to the pre-change call, second argument included: the
    // handler still passes NO values array on this branch.
    expect(paramsOf(0)).toBeUndefined()
  })

  it("runs the same relatedTo/relatedType query for a broker role", async () => {
    ctxMock.mockReturnValue(brokerCtx())
    await GET(req("?relatedTo=LD-ABC123&relatedType=Load"))

    expect(sqlOf(0)).toBe(
      "SELECT * FROM documents WHERE related_to = $1 AND related_type = $2 ORDER BY created_at DESC",
    )
    expect(paramsOf(0)).toEqual(["LD-ABC123", "Load"])
  })

  it("runs the same search query for a broker role, with no driver predicate", async () => {
    ctxMock.mockReturnValue(brokerCtx())
    await GET(req("?search=rate"))

    const sql = sqlOf(0)
    // Unparenthesised, exactly as before -- the parens exist only on the
    // driver branch, where they are load-bearing.
    expect(sql).toBe(
      "SELECT * FROM documents WHERE name ILIKE $1 OR related_to ILIKE $1 ORDER BY created_at DESC",
    )
    expect(sql).not.toContain("driver_id")
    expect(paramsOf(0)).toEqual(["%rate%"])
  })

  it("does not fail closed on a non-UUID userId for a non-driver role", async () => {
    // Broker user ids are "usr-..." strings, never UUIDs. The UUID guard must
    // be reachable only on the driver branch.
    ctxMock.mockReturnValue(brokerCtx())
    await GET(req("?relatedType=Load"))
    expect(queryMock).toHaveBeenCalledTimes(1)
  })
})
