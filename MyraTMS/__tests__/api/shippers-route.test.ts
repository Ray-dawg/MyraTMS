import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const query = vi.fn()
vi.mock("@/lib/db/tenant-context", () => ({
  withTenant: vi.fn(async (_tid: unknown, fn: (c: { query: typeof query }) => unknown) => fn({ query })),
}))
vi.mock("@/lib/auth", () => ({
  requireTenantContext: vi.fn(() => ({ tenantId: 42, role: "admin", userId: "u1", isSuperAdmin: false })),
  getCurrentUser: vi.fn(() => ({ firstName: "Cal", lastName: "Caller" })),
}))

import { POST } from "@/app/api/shippers/route"

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/shippers", { method: "POST", body: JSON.stringify(body) }),
  )
}

describe("POST /api/shippers assigned rep", () => {
  beforeEach(() => query.mockReset())

  it("omitted rep: no lookup query, uses caller name", async () => {
    query.mockResolvedValue({ rows: [] })
    const res = await post({ company: "Acme" })
    expect(res.status).toBe(201)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toMatch(/INSERT INTO shippers/)
    expect(query.mock.calls[0][1][5]).toBe("Cal Caller")
  })

  it("unknown rep: 400 and nothing inserted", async () => {
    query.mockResolvedValue({ rows: [] })
    const res = await post({ company: "Acme", assignedRep: "Nobody Here" })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Unknown assigned rep" })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).not.toMatch(/INSERT/)
  })

  it("valid rep: lookup params are [tenantId, name] and insert uses it", async () => {
    query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }).mockResolvedValueOnce({ rows: [] })
    const res = await post({ company: "Acme", assignedRep: "Ada Lovelace" })
    expect(res.status).toBe(201)
    const [lookupSql, lookupParams] = query.mock.calls[0]
    expect(lookupSql).toMatch(/tu\.role IN \('owner', 'admin', 'operator'\)/)
    expect(lookupParams).toEqual([42, "Ada Lovelace"])
    expect(query.mock.calls[1][1][5]).toBe("Ada Lovelace")
  })
})
