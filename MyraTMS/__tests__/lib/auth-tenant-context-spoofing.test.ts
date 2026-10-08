import { describe, it, expect, beforeAll } from "vitest"

// ---------------------------------------------------------------------------
// Regression tests for the 2026-10-08 tenant-header bypass.
//
// getTenantContext() used to read x-myra-tenant-id straight off the request,
// trusting middleware.ts to overwrite whatever the client sent. middleware was
// never running (malformed matcher -- see __tests__/middleware-matcher.test.ts),
// so on production:
//
//   curl -H "x-myra-tenant-id: 2" https://<app>/api/loads   ->  200 + real rows
//
// with no cookie and no token. These tests pin the fixed contract: tenant
// context comes from the signed JWT, and the headers are never authoritative.
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-jwt-secret-for-vitest-do-not-use-in-prod"

beforeAll(() => {
  process.env.JWT_SECRET = TEST_SECRET
})

let createToken: typeof import("@/lib/auth").createToken
let getTenantContext: typeof import("@/lib/auth").getTenantContext
let requireTenantContext: typeof import("@/lib/auth").requireTenantContext

beforeAll(async () => {
  const mod = await import("@/lib/auth")
  createToken = mod.createToken
  getTenantContext = mod.getTenantContext
  requireTenantContext = mod.requireTenantContext
})

function fakeRequest(opts: {
  headers?: Record<string, string>
  cookieToken?: string
}) {
  const headers = opts.headers ?? {}
  return {
    cookies: {
      get: (name: string) =>
        name === "auth-token" && opts.cookieToken
          ? { value: opts.cookieToken }
          : undefined,
    },
    headers: { get: (name: string) => headers[name] ?? null },
  } as unknown as import("next/server").NextRequest
}

const SPOOFED = {
  "x-myra-tenant-id": "2",
  "x-myra-tenant-role": "admin",
  "x-myra-user-id": "attacker",
  "x-myra-super-admin": "1",
}

describe("getTenantContext does not trust request headers", () => {
  it("returns null for forged x-myra-* headers with no token (the live exploit)", () => {
    expect(getTenantContext(fakeRequest({ headers: SPOOFED }))).toBeNull()
  })

  it("throws for forged headers with no token, instead of granting access", () => {
    expect(() => requireTenantContext(fakeRequest({ headers: SPOOFED }))).toThrow()
  })

  it("ignores a forged tenant id when a valid token says otherwise", () => {
    const token = createToken({
      userId: "usr-1",
      email: "a@b.c",
      role: "operator",
      firstName: "A",
      lastName: "B",
      tenantId: 7,
      tenantIds: [7],
    } as Parameters<typeof createToken>[0])
    const ctx = getTenantContext(
      fakeRequest({ headers: SPOOFED, cookieToken: token }),
    )
    expect(ctx).not.toBeNull()
    expect(ctx!.tenantId).toBe(7)
    expect(ctx!.role).toBe("operator")
    expect(ctx!.userId).toBe("usr-1")
  })

  it("ignores a forged super-admin header when the token does not claim it", () => {
    const token = createToken({
      userId: "usr-2",
      email: "a@b.c",
      role: "operator",
      firstName: "A",
      lastName: "B",
      tenantId: 7,
      tenantIds: [7],
    } as Parameters<typeof createToken>[0])
    const ctx = getTenantContext(
      fakeRequest({ headers: SPOOFED, cookieToken: token }),
    )
    expect(ctx!.isSuperAdmin).toBe(false)
  })

  it("resolves from a Bearer token too (DApp cross-origin path)", () => {
    const token = createToken({
      userId: "drv-1",
      email: "d@b.c",
      role: "driver",
      firstName: "D",
      lastName: "R",
      tenantId: 2,
      tenantIds: [2],
    } as Parameters<typeof createToken>[0])
    const ctx = getTenantContext(
      fakeRequest({ headers: { Authorization: `Bearer ${token}` } }),
    )
    expect(ctx!.tenantId).toBe(2)
    expect(ctx!.role).toBe("driver")
  })

  it("returns null for a token signed with the wrong secret", () => {
    const ctx = getTenantContext(
      fakeRequest({ cookieToken: "not.a.jwt", headers: SPOOFED }),
    )
    expect(ctx).toBeNull()
  })
})
