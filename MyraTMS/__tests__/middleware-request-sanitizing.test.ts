import { describe, it, expect, beforeAll } from "vitest"
import { NextRequest } from "next/server"
import jwt from "jsonwebtoken"
import { middleware, STRIPPED_REQUEST_HEADERS } from "@/middleware"

// ---------------------------------------------------------------------------
// Third companion to middleware-matcher.test.ts (does middleware SEE the
// route?) and middleware-public-paths.test.ts (does it classify the route
// correctly?). This one invokes the real middleware() function and inspects
// the response it hands back to Next, which is the only place the two
// behaviours below are observable.
//
// Pins FINDING 4 (dead x-myra-* header injection) and FINDING 5 (page routes
// accepted an unverified cookie), both from the 2026-10-08 round-3 review.
//
// How the header assertions work -- this is a real Next contract, not a guess:
// NextResponse.next({ request: { headers } }) sets
// `x-middleware-override-headers` to the comma-joined key list plus one
// `x-middleware-request-<key>` per entry
// (next/dist/server/web/spec-extension/response.js handleMiddlewareField).
// Next then DELETES every inbound request header absent from that list before
// the handler runs (next/dist/server/lib/router-utils/resolve-routes.js, the
// "// Delete headers." loop). So:
//   * an override list that omits x-myra-tenant-id  => the header is REMOVED;
//   * no override list at all                       => the header SURVIVES.
// Asserting the list exists AND omits the key therefore fails against the
// pre-fix code (which emitted no list on public/page paths, and on API paths
// emitted one that explicitly SET x-myra-tenant-id) and passes after.
// ---------------------------------------------------------------------------

const SECRET = "middleware-request-sanitizing-test-secret"

/** A signed, unexpired token of the shape lib/auth.ts createToken() issues. */
function signToken(over: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      userId: "usr-1",
      email: "op@example.com",
      role: "admin",
      firstName: "Op",
      lastName: "Erator",
      tenantId: 2,
      tenantIds: [2],
      ...over,
    },
    SECRET,
    { expiresIn: "1h" },
  )
}

function request(
  pathname: string,
  opts: { headers?: Record<string, string>; cookie?: string; bearer?: string } = {},
): NextRequest {
  const headers = new Headers(opts.headers ?? {})
  if (opts.cookie) headers.set("cookie", `auth-token=${opts.cookie}`)
  if (opts.bearer) headers.set("Authorization", `Bearer ${opts.bearer}`)
  return new NextRequest(new URL(`http://localhost:3000${pathname}`), { headers })
}

/** The header names middleware told Next to use for the downstream request. */
function overrideList(res: Response): string[] | null {
  const raw = res.headers.get("x-middleware-override-headers")
  if (raw === null) return null
  return raw.split(",").map((s) => s.trim()).filter(Boolean)
}

const FORGED: Record<string, string> = {
  "x-myra-tenant-id": "2",
  "x-myra-tenant-role": "admin",
  "x-myra-user-id": "attacker",
  "x-myra-super-admin": "1",
}

beforeAll(() => {
  process.env.JWT_SECRET = SECRET
})

// ---------------------------------------------------------------------------
// FINDING 4 -- caller-supplied x-myra-* headers never reach a handler.
// ---------------------------------------------------------------------------
describe("middleware strips forged x-myra-* request headers", () => {
  it("covers exactly the four headers getTenantContext() used to trust", () => {
    expect([...STRIPPED_REQUEST_HEADERS]).toEqual([
      "x-myra-tenant-id",
      "x-myra-tenant-role",
      "x-myra-user-id",
      "x-myra-super-admin",
    ])
  })

  // The sharp case. A public path needs no credential at all, so pre-fix a
  // forged header arrived at the handler completely untouched -- this is where
  // the dead injection was most dangerous.
  it("strips them on a PUBLIC path (no JWT involved)", async () => {
    const res = await middleware(request("/api/auth/login", { headers: FORGED }))
    const list = overrideList(res)
    expect(list, "public branch emitted no header override, so forged headers survive").not.toBeNull()
    for (const h of STRIPPED_REQUEST_HEADERS) {
      expect(list).not.toContain(h)
      expect(res.headers.get(`x-middleware-request-${h}`)).toBeNull()
    }
  })

  it("strips them on a self-authenticating path (cron)", async () => {
    const res = await middleware(request("/api/cron/exception-detect", { headers: FORGED }))
    const list = overrideList(res)
    expect(list).not.toBeNull()
    for (const h of STRIPPED_REQUEST_HEADERS) expect(list).not.toContain(h)
  })

  it("strips them on a token-in-path tracking route", async () => {
    const res = await middleware(request("/api/tracking/tok_abc123", { headers: FORGED }))
    const list = overrideList(res)
    expect(list).not.toBeNull()
    for (const h of STRIPPED_REQUEST_HEADERS) expect(list).not.toContain(h)
  })

  it("strips them on an authenticated API route", async () => {
    const res = await middleware(
      request("/api/loads", { headers: FORGED, cookie: signToken() }),
    )
    const list = overrideList(res)
    expect(list).not.toBeNull()
    for (const h of STRIPPED_REQUEST_HEADERS) expect(list).not.toContain(h)
  })

  it("strips them on an authenticated page route", async () => {
    const res = await middleware(
      request("/loads", { headers: FORGED, cookie: signToken() }),
    )
    const list = overrideList(res)
    expect(list).not.toBeNull()
    for (const h of STRIPPED_REQUEST_HEADERS) expect(list).not.toContain(h)
  })

  // The other half of FINDING 4: the injection itself is gone. Pre-fix an
  // authenticated API request came back with
  // x-middleware-request-x-myra-tenant-id: "2" set from the JWT. Nothing reads
  // those headers since dd649f1, so emitting them is a trap for the next
  // person who writes request.headers.get("x-myra-tenant-id") in a handler.
  it("no longer INJECTS tenant headers on an authenticated API route", async () => {
    const res = await middleware(request("/api/loads", { cookie: signToken() }))
    for (const h of STRIPPED_REQUEST_HEADERS) {
      expect(
        res.headers.get(`x-middleware-request-${h}`),
        `${h} is still being injected; handlers must read tenant context from the JWT`,
      ).toBeNull()
    }
  })

  it("leaves a clean request completely alone (no override emitted)", async () => {
    // Deploy-risk guard: the overwhelming majority of real traffic carries
    // none of these headers and must take the identical plain
    // NextResponse.next() path it takes today.
    const res = await middleware(request("/api/loads", { cookie: signToken() }))
    expect(overrideList(res)).toBeNull()
  })

  it("preserves every other request header when it does strip", async () => {
    const res = await middleware(
      request("/api/auth/login", {
        headers: { ...FORGED, "x-request-id": "req-42", "content-type": "application/json" },
      }),
    )
    const list = overrideList(res)
    expect(list).toContain("x-request-id")
    expect(list).toContain("content-type")
    expect(res.headers.get("x-middleware-request-x-request-id")).toBe("req-42")
  })
})

// ---------------------------------------------------------------------------
// FINDING 5 -- page routes verify the JWT signature, and fail by redirecting.
// ---------------------------------------------------------------------------
describe("middleware verifies the auth cookie on page routes", () => {
  const PAGE_ROUTES = ["/", "/loads", "/loads/LD-ABC123", "/admin/tenants", "/shippers"]

  it.each(PAGE_ROUTES)("redirects %s to /login for a garbage cookie", async (pathname) => {
    const res = await middleware(request(pathname, { cookie: "garbage" }))
    expect(
      res.status,
      "page route accepted an unverified cookie -- the first server component added here would render tenant data",
    ).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login")
  })

  it("redirects rather than 401s, so a browser navigation is recoverable", async () => {
    const res = await middleware(request("/loads", { cookie: "garbage" }))
    expect(res.status).not.toBe(401)
    expect(res.headers.get("location")).toBeTruthy()
  })

  it("clears the unusable cookie on the way out", async () => {
    const res = await middleware(request("/loads", { cookie: "garbage" }))
    const setCookie =
      res.headers.get("set-cookie") ?? res.headers.get("x-middleware-set-cookie") ?? ""
    expect(setCookie).toContain("auth-token=")
    expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i)
  })

  it("rejects a token signed with the wrong secret", async () => {
    const forged = jwt.sign({ userId: "x", role: "admin", tenantId: 2 }, "not-the-secret")
    const res = await middleware(request("/admin/tenants", { cookie: forged }))
    expect(res.status).toBe(307)
  })

  it("rejects an expired token", async () => {
    const expired = jwt.sign(
      { userId: "x", role: "admin", tenantId: 2, exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET,
    )
    const res = await middleware(request("/loads", { cookie: expired }))
    expect(res.status).toBe(307)
  })

  it("lets a valid cookie through to the page", async () => {
    const res = await middleware(request("/loads", { cookie: signToken() }))
    expect(res.status).toBe(200)
    expect(res.headers.get("location")).toBeNull()
  })

  // No redirect loop: /login and the other public pages return before any
  // token is examined, so a bad cookie cannot bounce forever.
  it.each(["/login", "/rate/sometoken", "/invite/sometoken"])(
    "does not redirect public page %s even with a garbage cookie",
    async (pathname) => {
      const res = await middleware(request(pathname, { cookie: "garbage" }))
      expect(res.status).toBe(200)
      expect(res.headers.get("location")).toBeNull()
    },
  )

  it("still 401s an API route for a garbage token (unchanged)", async () => {
    const res = await middleware(request("/api/loads", { cookie: "garbage" }))
    expect(res.status).toBe(401)
  })

  it("still redirects a page route with no cookie at all (unchanged)", async () => {
    const res = await middleware(request("/loads"))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login")
  })

  // The driver gate stays API-only, as before this change.
  it("403s a driver JWT on a non-driver API path", async () => {
    const res = await middleware(
      request("/api/shippers", { bearer: signToken({ role: "driver" }) }),
    )
    expect(res.status).toBe(403)
  })

  it("lets a driver JWT reach the DApp surface", async () => {
    const res = await middleware(
      request("/api/drivers/me/loads", { bearer: signToken({ role: "driver" }) }),
    )
    expect(res.status).toBe(200)
  })
})
