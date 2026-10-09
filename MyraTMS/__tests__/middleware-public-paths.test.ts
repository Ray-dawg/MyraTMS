import { describe, it, expect } from "vitest"
import { readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import {
  DRIVER_ALLOWED_EXACT,
  isDriverAllowedPath,
  isPublicPath,
  PUBLIC_PATHS,
  SELF_AUTHENTICATING_PATHS,
} from "@/middleware"

// ---------------------------------------------------------------------------
// Companion to __tests__/middleware-matcher.test.ts.
//
// That test proves middleware SEES every real route. This one proves it makes
// the right call once it does. Until 2026-10-08 the matcher matched no path at
// all, so middleware had never executed in production and its publicPaths list
// had never been validated against real traffic. Enabling it 401s anything
// that authenticates with a shared secret or an HMAC signature rather than a
// user JWT -- all 8 Vercel crons, the pipeline import token, the Retell
// webhook -- unless those paths are bypassed.
//
// The bypass list is imported, never copied: a test that duplicates the list
// it is checking cannot catch a missing entry.
// ---------------------------------------------------------------------------

const CRON_DIR = join(process.cwd(), "app", "api", "cron")
const LOADS_DIR = join(process.cwd(), "app", "api", "loads")
const TRACKING_DIR = join(process.cwd(), "app", "api", "tracking")

/** Every cron route that actually exists on disk, as a request pathname. */
function cronRoutePathnames(): string[] {
  return readdirSync(CRON_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(CRON_DIR, e.name, "route.ts")))
    .map((e) => `/api/cron/${e.name}`)
    .sort()
}

/**
 * Static (non-dynamic) route segments sitting alongside app/api/loads/[id].
 * Derived from disk so a newly added sibling forces a classification
 * decision instead of silently inheriting the driver allowlist.
 */
function loadsStaticSiblings(): string[] {
  return readdirSync(LOADS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("["))
    .map((e) => e.name)
    .sort()
}

/**
 * Every route.ts under app/api/tracking, as a request pathname, with the
 * dynamic [token] segment substituted. Derived from disk so a newly added
 * tracking route forces a classification decision rather than silently
 * inheriting (or silently losing) the token-in-path bypass.
 */
function trackingRoutePathnames(): string[] {
  const out: string[] = []
  const walk = (dir: string, segs: string[]) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const next = [...segs, e.name === "[token]" ? "abc123" : e.name]
      if (existsSync(join(dir, e.name, "route.ts"))) {
        out.push(`/api/tracking/${next.join("/")}`)
      }
      walk(join(dir, e.name), next)
    }
  }
  walk(TRACKING_DIR, [])
  return out.sort()
}

// Non-cron paths that must be public. Cron paths are derived from the
// filesystem below instead of being listed here on purpose.
const MUST_BE_PUBLIC = [
  // Unauthenticated by design -- login, invite acceptance, public rating page.
  "/login",
  "/api/auth/login",
  "/api/auth/driver-login",
  "/api/auth/accept-invite",
  "/api/drivers/accept-invite",
  "/api/drivers/invite/abc123",
  "/invite/abc123",
  "/rate/abc123",
  "/api/rate/abc123",
  // Token-in-path: the token IS the credential.
  "/api/tracking/abc123",
  "/api/tracking/abc123/documents",
  "/api/tracking/abc123/sse",
  "/api/confirmations/abc123",
  "/api/confirmations/abc123/confirm",
  "/api/confirmations/abc123/decline",
  // Self-authenticating machine endpoints (see SELF_AUTHENTICATING_PATHS).
  "/api/pipeline/import",
  "/api/webhooks/retell-callback",
  "/api/health",
]

// Paths middleware MUST challenge. A regression that makes any of these public
// is the 2026-10-08 bug class all over again: an anonymous caller reaching
// tenant data. /verbal is the sharp edge -- it sits under the same dynamic
// [token] segment as three genuinely public routes but is an ops-only override.
const MUST_BE_PROTECTED = [
  // Core tenant data.
  "/api/loads",
  "/api/loads/LD-ABC123",
  "/api/shippers",
  "/api/carriers",
  "/api/invoices",
  // Driver-reachable (see the driver-allowlist describe block below) but
  // still NOT public: a driver Bearer token is required. "driver-allowed" and
  // "public" are different axes -- do not delete this line to make the DApp
  // Docs tab work.
  "/api/documents",
  "/api/quotes",
  "/api/drivers",
  "/api/drivers/me",
  // Admin + Engine 3 surfaces.
  "/api/admin/tenants",
  "/api/events",
  "/api/metrics/funnel",
  "/api/finance/float-exposure",
  "/api/risk/halts",
  "/api/pricing/quote",
  "/api/tenants",
  // Authenticated ops override living under the public confirmations prefix.
  "/api/confirmations/abc123/verbal",
  // Clearing the session cookie still requires a valid one.
  "/api/auth/logout",
  "/api/auth/me",
  // Browser-only, cookie-authenticated.
  "/api/import/template/carriers",
  "/api/import/validate",
  // Page routes.
  "/",
  "/loads",
  "/admin/tenants",
  "/tracking",
  // Routes under /api/tracking/ that are NOT token-in-path. Both authenticate
  // as a normal user (getCurrentUser + requireTenantContext), so the old bare
  // "/api/tracking/" prefix bypass was wrong about them.
  "/api/tracking/positions",
  "/api/tracking/checkcall",
  // Near-misses on the public prefixes -- these must NOT inherit the bypass.
  "/api/confirmations",
  "/api/tracking",
  "/api/drivers/invite-bulk",
  "/api/cron",
  "/api/cronx/anything",
  "/api/cron/exception-detect/subpath",
  "/api/pipeline/import/extra",
  "/api/healthz",
]

describe("middleware public-path classification", () => {
  it("finds cron routes on disk", () => {
    expect(cronRoutePathnames().length).toBeGreaterThan(0)
  })

  it.each(cronRoutePathnames())(
    "%s is bypassed (it authenticates with CRON_SECRET, not a user JWT)",
    (pathname) => {
      expect(isPublicPath(pathname)).toBe(true)
    },
  )

  // The guard that makes the above meaningful: a new cron dir must be added to
  // SELF_AUTHENTICATING_PATHS, not merely matched by some broader prefix.
  it("lists every on-disk cron route in SELF_AUTHENTICATING_PATHS", () => {
    const listed = SELF_AUTHENTICATING_PATHS.filter((p) => p.startsWith("/api/cron/")).sort()
    expect(listed).toEqual(cronRoutePathnames())
  })

  it.each(MUST_BE_PUBLIC)("%s is public", (pathname) => {
    expect(isPublicPath(pathname)).toBe(true)
  })

  it.each(MUST_BE_PROTECTED)("%s is protected", (pathname) => {
    expect(isPublicPath(pathname)).toBe(false)
  })

  it("keeps every bypass entry exact-match, never a prefix", () => {
    for (const p of SELF_AUTHENTICATING_PATHS) {
      expect(p.endsWith("/")).toBe(false)
      // A bypassed path must not swallow its own subtree.
      expect(isPublicPath(`${p}/anything`)).toBe(false)
    }
  })

  // -------------------------------------------------------------------------
  // FINDING 2 (2026-10-08): TRACKING_PREFIX was a bare "/api/tracking/"
  // startsWith, which bypassed /api/tracking/positions (GPS for every load in
  // the tenant) and /api/tracking/checkcall (POST, writes check_calls +
  // activity_notes). Neither is token-in-path; both call getCurrentUser() and
  // requireTenantContext(). Post-Layer-1 there was no live hole, but the
  // bypass list advertises that every entry enforces its own credential, and
  // isPublicPath("/api/tracking/positions") silently returned true.
  //
  // These assertions fail against the bare-prefix version and pass against
  // PUBLIC_TRACKING_PATH.
  // -------------------------------------------------------------------------
  it("finds tracking routes on disk", () => {
    expect(trackingRoutePathnames()).toEqual([
      "/api/tracking/abc123",
      "/api/tracking/abc123/documents",
      "/api/tracking/abc123/events",
      "/api/tracking/abc123/sse",
      "/api/tracking/checkcall",
      "/api/tracking/positions",
    ])
  })

  // The classification, derived from disk rather than from a hand-kept list:
  // only the [token] routes are token-in-path.
  const TOKEN_IN_PATH_TRACKING = new Set([
    "/api/tracking/abc123",
    "/api/tracking/abc123/documents",
    "/api/tracking/abc123/events",
    "/api/tracking/abc123/sse",
  ])

  it("classifies every on-disk tracking route", () => {
    for (const pathname of trackingRoutePathnames()) {
      expect(
        isPublicPath(pathname),
        `${pathname}: token-in-path routes are public, user-authenticated ones are not. Classify it in TOKEN_IN_PATH_TRACKING and in PUBLIC_TRACKING_PATH in middleware.ts`,
      ).toBe(TOKEN_IN_PATH_TRACKING.has(pathname))
    }
  })

  it("cannot be re-opened through the optional sub-segment group", () => {
    // positions/checkcall must stay protected whether they END the path or
    // carry a sub-segment, so a nonexistent /api/tracking/positions/documents
    // cannot slip through the (documents|events|sse) group.
    for (const p of [
      "/api/tracking/positions",
      "/api/tracking/positions/documents",
      "/api/tracking/positions/events",
      "/api/tracking/positions/sse",
      "/api/tracking/checkcall",
      "/api/tracking/checkcall/documents",
      "/api/tracking/checkcall/sse",
    ]) {
      expect(isPublicPath(p)).toBe(false)
    }
  })

  it("keeps the tracking bypass to known sub-routes only", () => {
    // A real token still works, including the three sub-routes...
    expect(isPublicPath("/api/tracking/tok_live_abc123")).toBe(true)
    expect(isPublicPath("/api/tracking/tok_live_abc123/documents")).toBe(true)
    // ...but an unknown sub-route under [token] defaults to PROTECTED, same
    // contract as PUBLIC_CONFIRMATION_PATH.
    expect(isPublicPath("/api/tracking/tok_live_abc123/anything")).toBe(false)
    expect(isPublicPath("/api/tracking/tok_live_abc123/a/b")).toBe(false)
    expect(isPublicPath("/api/tracking/")).toBe(false)
  })

  it("does not bypass a whole subtree via any PUBLIC_PATHS prefix", () => {
    // Every prefix entry (trailing slash) must be narrow enough that the
    // resource collection one level up stays protected.
    for (const p of PUBLIC_PATHS.filter((x) => x.endsWith("/"))) {
      const parent = p.replace(/\/[^/]+\/$/, "")
      if (parent && parent !== "" && parent !== "/api") {
        expect(isPublicPath(parent)).toBe(false)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Driver allowlist.
//
// A different axis from isPublicPath(): every path below still requires a
// valid JWT. The question here is which of them a *driver* JWT may reach.
// Until 2026-10-08 middleware never ran, so this boundary had never been
// enforced and had drifted from the DApp in BOTH directions:
//   - too narrow: /api/documents was missing entirely, so the DApp Docs tab
//     would have started 403ing the moment middleware went live;
//   - too broad: startsWith("/api/loads/") handed drivers the whole loads
//     subtree, including /api/loads/<id>/assign and /api/loads/<id>/match,
//     neither of which calls requireRole().
//
// DRIVER_MUST_REACH is derived from real DApp call sites, each carrying the
// file:line that proves it. Narrowing the allowlist below this set breaks the
// PWA and fails here.
// ---------------------------------------------------------------------------

const DRIVER_MUST_REACH: Array<[string, string]> = [
  ["/api/drivers/me/loads", "GET DApp/app/page.tsx:56"],
  ["/api/documents", "GET DApp/components/docs-screen.tsx:81 ?relatedType=Load"],
  ["/api/loads/request", "POST DApp/components/request-load.tsx:54"],
  ["/api/loads/LD-ABC123", "PATCH DApp/app/page.tsx:162 + request-load.tsx:97"],
  ["/api/loads/LD-ABC123/location", "POST DApp/hooks/use-gps.ts:33 + sw.js replay"],
  ["/api/loads/LD-ABC123/pod", "POST DApp/components/pod-capture.tsx:42"],
  // Any role must be able to inspect and drop its own session.
  ["/api/auth/me", "session self-read"],
  ["/api/auth/logout", "session self-clear"],
]

// Everything a driver must NOT reach. The /api/loads/<id>/* entries are the
// point of the narrowing: each was reachable under the old bare
// startsWith("/api/loads/") prefix.
const DRIVER_MUST_NOT_REACH = [
  "/api/loads/LD-ABC123/assign", // requireTenantContext only, no requireRole
  "/api/loads/LD-ABC123/match", // requireTenantContext only, no requireRole
  "/api/loads/LD-ABC123/invoice",
  "/api/loads/LD-ABC123/send-tracking",
  "/api/loads/LD-ABC123/tracking-token",
  "/api/loads/LD-ABC123/events",
  "/api/loads/LD-ABC123/confirm-carrier-signature",
  "/api/loads/LD-ABC123/pod/extra",
  "/api/loads/LD-ABC123/location/extra",
  "/api/loads/bulk-match",
  "/api/loads/map",
  "/api/loads",
  // /api/documents is exact-match only; its subtree is broker/Engine-3 surface.
  "/api/documents/DOC-1",
  "/api/documents/upload",
  "/api/documents/download-all",
  "/api/documents/rate-con/PL-1",
  "/api/documents/terms-mismatches",
  "/api/documents/intake-match-report",
  // Driver roster and other tenant data.
  "/api/drivers",
  "/api/drivers/DRV-1",
  "/api/shippers",
  "/api/carriers",
  "/api/invoices",
  "/api/quotes",
  "/api/admin/tenants",
  "/api/pricing/quote",
  "/api/finance/float-exposure",
  // Near-misses on the exact entries.
  "/api/auth/me-all",
  "/api/auth/logout-everywhere",
  "/api/drivers/me/loadsx",
  "/api/documentsx",
]

// Static siblings of app/api/loads/[id] that the driver surface includes.
// Everything else on disk must be closed; see the classification test below.
const DRIVER_ALLOWED_LOADS_SIBLINGS = ["request"]

describe("middleware driver allowlist", () => {
  it.each(DRIVER_MUST_REACH)("driver can reach %s (%s)", (pathname) => {
    expect(isDriverAllowedPath(pathname)).toBe(true)
  })

  it.each(DRIVER_MUST_NOT_REACH)("driver cannot reach %s", (pathname) => {
    expect(isDriverAllowedPath(pathname)).toBe(false)
  })

  // The named regression guard: widening the loads rule back to a bare
  // startsWith prefix makes all of these allowed and fails this test.
  it("never grants the driver a bare /api/loads/ subtree", () => {
    for (const p of [
      "/api/loads/LD-1/assign",
      "/api/loads/LD-1/anything",
      "/api/loads/LD-1/a/b",
      "/api/loads/",
    ]) {
      expect(isDriverAllowedPath(p)).toBe(false)
    }
  })

  it("grants /api/documents by exact equality, never as a prefix", () => {
    expect(isDriverAllowedPath("/api/documents")).toBe(true)
    expect(isDriverAllowedPath("/api/documents/")).toBe(false)
    expect(isDriverAllowedPath("/api/documents/anything")).toBe(false)
  })

  it("classifies every static sibling of app/api/loads/[id]", () => {
    const siblings = loadsStaticSiblings()
    expect(siblings.length).toBeGreaterThan(0)
    for (const name of siblings) {
      const expected = DRIVER_ALLOWED_LOADS_SIBLINGS.includes(name)
      expect(
        isDriverAllowedPath(`/api/loads/${name}`),
        `/api/loads/${name}: classify it in DRIVER_ALLOWED_LOADS_SIBLINGS and, if it must stay closed, in the DRIVER_LOAD_ITEM_PATH lookahead in middleware.ts`,
      ).toBe(expected)
    }
  })

  it("keeps every DRIVER_ALLOWED_EXACT entry exact (no trailing slash, no subtree)", () => {
    for (const p of DRIVER_ALLOWED_EXACT) {
      expect(p.endsWith("/")).toBe(false)
      expect(isDriverAllowedPath(`${p}/anything`)).toBe(false)
    }
  })

  // The driver surface is authenticated surface: nothing on it may also be
  // public, or an anonymous caller would reach driver data with no token.
  it("no driver-allowed path is also public", () => {
    for (const [pathname] of DRIVER_MUST_REACH) {
      expect(isPublicPath(pathname)).toBe(false)
    }
  })
})
