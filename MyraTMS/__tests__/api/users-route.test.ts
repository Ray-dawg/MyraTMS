import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const query = vi.fn()
vi.mock("@/lib/db/tenant-context", () => ({
  withTenant: vi.fn(async (_tid: unknown, fn: (c: { query: typeof query }) => unknown) => fn({ query })),
}))
vi.mock("@/lib/auth", () => ({
  requireTenantContext: vi.fn(() => ({ tenantId: 42, role: "admin", userId: "u1", isSuperAdmin: false })),
}))

import { GET } from "@/app/api/users/route"
import { withTenant } from "@/lib/db/tenant-context"

describe("GET /api/users", () => {
  beforeEach(() => {
    query.mockReset()
    vi.mocked(withTenant).mockClear()
  })

  it("runs inside withTenant and filters on the caller's tenant_id", async () => {
    query.mockResolvedValue({ rows: [] })
    await GET(new NextRequest("http://localhost/api/users"))
    expect(withTenant).toHaveBeenCalledWith(42, expect.any(Function))
    const [sql, params] = query.mock.calls[0]
    expect(sql).toMatch(/tenant_users/)
    expect(sql).toMatch(/WHERE\s+tu\.tenant_id\s*=\s*\$1/)
    expect(params).toEqual([42])
    expect(sql).toMatch(/tu\.role IN \('owner', 'admin', 'operator'\)/)
    expect(sql).not.toMatch(/email/)
  })

  it("maps snake_case rows to camelCase and omits password_hash", async () => {
    query.mockResolvedValue({
      rows: [{ id: "u1", first_name: "Ada", last_name: "Lovelace", role: "admin" }],
    })
    const res = await GET(new NextRequest("http://localhost/api/users"))
    expect(await res.json()).toEqual([
      { id: "u1", firstName: "Ada", lastName: "Lovelace", role: "admin" },
    ])
    expect(query.mock.calls[0][0]).not.toMatch(/password_hash/)
  })
})
