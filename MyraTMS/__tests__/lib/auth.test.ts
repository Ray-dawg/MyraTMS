import { describe, it, expect, beforeAll, vi } from "vitest"
import jwt from "jsonwebtoken"

// ---------------------------------------------------------------------------
// Unit tests for lib/auth.ts
//
// We set JWT_SECRET in the environment so the auth module can run, then
// exercise createToken, verifyToken, getCurrentUser, requireRole, and the
// password hashing helpers.
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-jwt-secret-for-vitest-do-not-use-in-prod"

beforeAll(() => {
  process.env.JWT_SECRET = TEST_SECRET
})

// Dynamic import AFTER env is set so getJwtSecret() resolves
let createToken: typeof import("@/lib/auth").createToken
let verifyToken: typeof import("@/lib/auth").verifyToken
let getCurrentUser: typeof import("@/lib/auth").getCurrentUser
let requireRole: typeof import("@/lib/auth").requireRole
let hashPassword: typeof import("@/lib/auth").hashPassword
let comparePassword: typeof import("@/lib/auth").comparePassword
let getTenantContext: typeof import("@/lib/auth").getTenantContext
let requireTenantContext: typeof import("@/lib/auth").requireTenantContext
let LEGACY_DEFAULT_TENANT_ID: typeof import("@/lib/auth").LEGACY_DEFAULT_TENANT_ID

beforeAll(async () => {
  const mod = await import("@/lib/auth")
  createToken = mod.createToken
  verifyToken = mod.verifyToken
  getCurrentUser = mod.getCurrentUser
  requireRole = mod.requireRole
  hashPassword = mod.hashPassword
  comparePassword = mod.comparePassword
  getTenantContext = mod.getTenantContext
  requireTenantContext = mod.requireTenantContext
  LEGACY_DEFAULT_TENANT_ID = mod.LEGACY_DEFAULT_TENANT_ID
})

const samplePayload = {
  userId: "usr-001",
  email: "sarah@myratms.com",
  role: "admin",
  firstName: "Sarah",
  lastName: "Chen",
  tenantId: 2,
  tenantIds: [2],
}

// -- createToken / verifyToken ---------------------------------------------

describe("createToken", () => {
  it("returns a non-empty string", () => {
    const token = createToken(samplePayload)
    expect(typeof token).toBe("string")
    expect(token.length).toBeGreaterThan(0)
  })

  it("produces a valid JWT that can be decoded", () => {
    const token = createToken(samplePayload)
    const decoded = jwt.decode(token) as Record<string, unknown>
    expect(decoded).not.toBeNull()
    expect(decoded.email).toBe("sarah@myratms.com")
    expect(decoded.role).toBe("admin")
    expect(decoded.userId).toBe("usr-001")
  })

  it("sets the default expiry to 24h", () => {
    const token = createToken(samplePayload)
    const decoded = jwt.decode(token) as { iat: number; exp: number }
    // exp - iat should be 24 * 60 * 60 = 86400 seconds
    expect(decoded.exp - decoded.iat).toBe(86400)
  })

  it("respects custom expiresIn", () => {
    const token = createToken(samplePayload, "1h")
    const decoded = jwt.decode(token) as { iat: number; exp: number }
    expect(decoded.exp - decoded.iat).toBe(3600)
  })

  it("includes carrierId when provided", () => {
    const token = createToken({ ...samplePayload, carrierId: "CAR-001" })
    const decoded = jwt.decode(token) as Record<string, unknown>
    expect(decoded.carrierId).toBe("CAR-001")
  })
})

describe("verifyToken", () => {
  it("returns the payload for a valid token", () => {
    const token = createToken(samplePayload)
    const result = verifyToken(token)
    expect(result).not.toBeNull()
    expect(result!.userId).toBe("usr-001")
    expect(result!.email).toBe("sarah@myratms.com")
    expect(result!.role).toBe("admin")
    expect(result!.firstName).toBe("Sarah")
    expect(result!.lastName).toBe("Chen")
  })

  it("returns null for a tampered token", () => {
    const token = createToken(samplePayload)
    const tampered = token.slice(0, -5) + "XXXXX"
    expect(verifyToken(tampered)).toBeNull()
  })

  it("returns null for an expired token", () => {
    // Create a token that expired 10 seconds ago
    const expiredToken = jwt.sign(
      { ...samplePayload },
      TEST_SECRET,
      { expiresIn: -10 }
    )
    expect(verifyToken(expiredToken)).toBeNull()
  })

  it("returns null for a token signed with a different secret", () => {
    const wrongSecretToken = jwt.sign(samplePayload, "wrong-secret", {
      expiresIn: "1h",
    })
    expect(verifyToken(wrongSecretToken)).toBeNull()
  })

  it("returns null for an empty string", () => {
    expect(verifyToken("")).toBeNull()
  })

  it("returns null for garbage input", () => {
    expect(verifyToken("not.a.jwt")).toBeNull()
  })
})

// -- getCurrentUser --------------------------------------------------------

/**
 * Helper to build a minimal NextRequest-like object for testing.
 * We only need .cookies.get() and .headers.get() to match what
 * getCurrentUser() accesses.
 */
function makeFakeRequest(options: { cookie?: string; authHeader?: string }) {
  return {
    cookies: {
      get(name: string) {
        if (name === "auth-token" && options.cookie) {
          return { value: options.cookie }
        }
        return undefined
      },
    },
    headers: {
      get(name: string) {
        if (name === "Authorization" && options.authHeader) {
          return options.authHeader
        }
        return null
      },
    },
  } as unknown as import("next/server").NextRequest
}

describe("getCurrentUser", () => {
  it("extracts user from auth-token cookie", () => {
    const token = createToken(samplePayload)
    const req = makeFakeRequest({ cookie: token })
    const user = getCurrentUser(req)
    expect(user).not.toBeNull()
    expect(user!.email).toBe("sarah@myratms.com")
  })

  it("extracts user from Authorization Bearer header", () => {
    const token = createToken(samplePayload)
    const req = makeFakeRequest({ authHeader: `Bearer ${token}` })
    const user = getCurrentUser(req)
    expect(user).not.toBeNull()
    expect(user!.userId).toBe("usr-001")
  })

  it("prefers cookie over Bearer header", () => {
    const cookieToken = createToken({ ...samplePayload, email: "cookie@test.com" })
    const headerToken = createToken({ ...samplePayload, email: "header@test.com" })
    const req = makeFakeRequest({ cookie: cookieToken, authHeader: `Bearer ${headerToken}` })
    const user = getCurrentUser(req)
    expect(user!.email).toBe("cookie@test.com")
  })

  it("returns null when no token is present", () => {
    const req = makeFakeRequest({})
    expect(getCurrentUser(req)).toBeNull()
  })

  it("returns null for an invalid cookie token", () => {
    const req = makeFakeRequest({ cookie: "invalid-token" })
    expect(getCurrentUser(req)).toBeNull()
  })

  it("returns null for a non-Bearer Authorization header", () => {
    const req = makeFakeRequest({ authHeader: "Basic dXNlcjpwYXNz" })
    expect(getCurrentUser(req)).toBeNull()
  })
})

// -- requireRole -----------------------------------------------------------

describe("requireRole", () => {
  it("returns null (allowed) when user role matches", () => {
    const result = requireRole(
      { ...samplePayload, role: "admin" },
      "admin",
      "ops"
    )
    expect(result).toBeNull()
  })

  it("returns 403 Response when role is not allowed", () => {
    const result = requireRole(
      { ...samplePayload, role: "driver" },
      "admin",
      "ops"
    )
    expect(result).not.toBeNull()
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(403)
  })
})

// -- Password hashing ------------------------------------------------------

describe("hashPassword / comparePassword", () => {
  it("hashes and verifies a password correctly", async () => {
    const hash = await hashPassword("MySecureP@ss1")
    expect(hash).not.toBe("MySecureP@ss1")
    expect(hash.startsWith("$2")).toBe(true) // bcrypt prefix
    expect(await comparePassword("MySecureP@ss1", hash)).toBe(true)
  })

  it("rejects wrong password", async () => {
    const hash = await hashPassword("CorrectPassword")
    expect(await comparePassword("WrongPassword", hash)).toBe(false)
  })
})

// -- Multi-tenant JWT claims (Phase 2.3 / ADR-002) -------------------------

describe("createToken — tenant claims", () => {
  it("preserves explicit tenantId and tenantIds", () => {
    const token = createToken({
      ...samplePayload,
      tenantId: 5,
      tenantIds: [5, 7],
    })
    const decoded = jwt.decode(token) as Record<string, unknown>
    expect(decoded.tenantId).toBe(5)
    expect(decoded.tenantIds).toEqual([5, 7])
  })

  it("backfills LEGACY_DEFAULT_TENANT_ID when tenantId is omitted", () => {
    // Caller is a legacy site that hasn't been updated to pass tenantId yet.
    const legacyInput = {
      userId: "usr-legacy",
      email: "legacy@myratms.com",
      role: "broker",
      firstName: "Legacy",
      lastName: "User",
    }
    // Cast through unknown so the test exercises the runtime backfill, not TS.
    const token = createToken(legacyInput as unknown as Parameters<typeof createToken>[0])
    const decoded = jwt.decode(token) as Record<string, unknown>
    expect(decoded.tenantId).toBe(LEGACY_DEFAULT_TENANT_ID)
    expect(decoded.tenantIds).toEqual([LEGACY_DEFAULT_TENANT_ID])
  })

  it("derives tenantIds from tenantId when only tenantId is provided", () => {
    const token = createToken({ ...samplePayload, tenantId: 9, tenantIds: undefined })
    const decoded = jwt.decode(token) as Record<string, unknown>
    expect(decoded.tenantId).toBe(9)
    expect(decoded.tenantIds).toEqual([9])
  })

  it("includes isSuperAdmin when set", () => {
    const token = createToken({ ...samplePayload, isSuperAdmin: true })
    const decoded = jwt.decode(token) as Record<string, unknown>
    expect(decoded.isSuperAdmin).toBe(true)
  })
})

describe("verifyToken — legacy backfill", () => {
  it("backfills tenantId/tenantIds on legacy tokens issued without claims", () => {
    // Sign a token directly via jsonwebtoken (bypassing createToken's backfill)
    // to simulate a legacy token issued before Phase 2.3.
    const legacyToken = jwt.sign(
      {
        userId: "usr-legacy",
        email: "legacy@myratms.com",
        role: "admin",
        firstName: "L",
        lastName: "U",
      },
      TEST_SECRET,
      { expiresIn: "1h" },
    )
    const result = verifyToken(legacyToken)
    expect(result).not.toBeNull()
    expect(result!.tenantId).toBe(LEGACY_DEFAULT_TENANT_ID)
    expect(result!.tenantIds).toEqual([LEGACY_DEFAULT_TENANT_ID])
  })
})

// -- getTenantContext / requireTenantContext -------------------------------

function makeFakeRequestWithHeaders(headers: Record<string, string>) {
  return {
    cookies: { get: () => undefined },
    headers: {
      get(name: string) {
        // Header lookup is case-insensitive in real Headers; tests pass the
        // exact casing the auth code uses.
        return headers[name] ?? null
      },
    },
  } as unknown as import("next/server").NextRequest
}

describe("getTenantContext", () => {
  it("reads tenant context from x-myra-tenant-* headers", () => {
    const req = makeFakeRequestWithHeaders({
      "x-myra-tenant-id": "7",
      "x-myra-tenant-role": "admin",
      "x-myra-user-id": "usr-007",
      "x-myra-super-admin": "1",
    })
    const ctx = getTenantContext(req)
    expect(ctx).toEqual({
      tenantId: 7,
      role: "admin",
      userId: "usr-007",
      isSuperAdmin: true,
    })
  })

  it("returns null when x-myra-tenant-id header is absent", () => {
    const req = makeFakeRequestWithHeaders({})
    expect(getTenantContext(req)).toBeNull()
  })

  it("returns null when x-myra-tenant-id is non-numeric", () => {
    const req = makeFakeRequestWithHeaders({ "x-myra-tenant-id": "abc" })
    expect(getTenantContext(req)).toBeNull()
  })

  it("returns null when x-myra-tenant-id is zero or negative", () => {
    expect(getTenantContext(makeFakeRequestWithHeaders({ "x-myra-tenant-id": "0" }))).toBeNull()
    expect(getTenantContext(makeFakeRequestWithHeaders({ "x-myra-tenant-id": "-3" }))).toBeNull()
  })

  it("treats x-myra-super-admin != '1' as not-super-admin", () => {
    const req = makeFakeRequestWithHeaders({
      "x-myra-tenant-id": "2",
      "x-myra-super-admin": "true",
    })
    const ctx = getTenantContext(req)
    expect(ctx!.isSuperAdmin).toBe(false)
  })
})

describe("requireTenantContext", () => {
  it("prefers headers when present", () => {
    const req = makeFakeRequestWithHeaders({
      "x-myra-tenant-id": "7",
      "x-myra-tenant-role": "broker",
      "x-myra-user-id": "usr-7",
    })
    const ctx = requireTenantContext(req)
    expect(ctx.tenantId).toBe(7)
    expect(ctx.role).toBe("broker")
  })

  it("falls back to decoding the JWT cookie when headers are missing", () => {
    const token = createToken({ ...samplePayload, tenantId: 3, tenantIds: [3] })
    const req = {
      cookies: {
        get(name: string) {
          return name === "auth-token" ? { value: token } : undefined
        },
      },
      headers: { get: () => null },
    } as unknown as import("next/server").NextRequest
    const ctx = requireTenantContext(req)
    expect(ctx.tenantId).toBe(3)
    expect(ctx.userId).toBe("usr-001")
  })

  it("throws when neither headers nor a valid JWT are present", () => {
    const req = makeFakeRequestWithHeaders({})
    expect(() => requireTenantContext(req)).toThrow(/no tenant header/i)
  })
})
