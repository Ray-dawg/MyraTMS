import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

// ---------------------------------------------------------------------------
// CORS configuration (inlined because middleware runs in Edge runtime and
// cannot use standard @/lib imports)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// JWT verification using Web Crypto API (Edge-runtime compatible).
// jsonwebtoken cannot run in Edge runtime; we verify the HMAC-SHA256 signature
// here so that role extraction for RBAC is cryptographically trusted.
//
// SECURITY FIX: The previous implementation decoded the JWT payload with
// atob(token.split('.')[1]) WITHOUT verifying the signature. This allowed
// an attacker to craft a token with any role claim (e.g. role:"admin") and
// bypass RBAC entirely. This function performs a full HMAC-SHA256 signature
// check using JWT_SECRET before trusting any claim in the payload.
// ---------------------------------------------------------------------------

async function verifyJwtEdge(token: string): Promise<Record<string, unknown> | null> {
  try {
    const secret = process.env.JWT_SECRET
    if (!secret) return null

    const parts = token.split(".")
    if (parts.length !== 3) return null

    const [headerB64, payloadB64, signatureB64] = parts

    // Import the HMAC-SHA256 key
    const encoder = new TextEncoder()
    const keyData = encoder.encode(secret)
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    )

    // Decode the signature (base64url -> Uint8Array)
    const signaturePadded = signatureB64.replace(/-/g, "+").replace(/_/g, "/")
    const signatureBytes = Uint8Array.from(atob(signaturePadded), (c) => c.charCodeAt(0))

    // Verify signature over header.payload
    const signingInput = encoder.encode(headerB64 + "." + payloadB64)
    const valid = await crypto.subtle.verify("HMAC", cryptoKey, signatureBytes, signingInput)
    if (!valid) return null

    // Signature is valid -- safe to decode the payload
    const payloadJson = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"))
    const payload = JSON.parse(payloadJson) as Record<string, unknown>

    // Check token expiry (exp claim is in seconds)
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
      return null
    }

    return payload
  } catch {
    return null
  }
}

const ALLOWED_ORIGINS = [
  process.env.NEXT_PUBLIC_APP_URL,
  process.env.NEXT_PUBLIC_DRIVER_APP_URL,
  process.env.NEXT_PUBLIC_TRACKING_URL,
  ...(process.env.NODE_ENV === "development"
    ? ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"]
    : []),
].filter(Boolean) as string[]

const ALLOWED_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS"
const ALLOWED_HEADERS = "Content-Type, Authorization"

function getAllowedOrigin(request: NextRequest): string {
  const origin = request.headers.get("origin") || ""
  if (ALLOWED_ORIGINS.includes(origin)) {
    return origin
  }
  return ""
}

function handleCorsPreflight(request: NextRequest): NextResponse {
  const origin = getAllowedOrigin(request)
  if (!origin) {
    return new NextResponse(null, { status: 403 })
  }
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": ALLOWED_METHODS,
      "Access-Control-Allow-Headers": ALLOWED_HEADERS,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
    },
  })
}

// ---------------------------------------------------------------------------
// Helper: attach CORS headers to any response
// ---------------------------------------------------------------------------

function withCors(request: NextRequest, response: NextResponse): NextResponse {
  const origin = getAllowedOrigin(request)
  if (origin) {
    response.headers.set("Access-Control-Allow-Origin", origin)
    response.headers.set("Access-Control-Allow-Credentials", "true")
  }
  return response
}

// ---------------------------------------------------------------------------
// Tenant resolution (ADR-002) -- NOT done here any more.
//
// This middleware used to resolve a tenant id from the JWT and forward it to
// handlers as x-myra-tenant-id / -tenant-role / -user-id / -super-admin, which
// lib/auth.ts getTenantContext() then read back. Commit dd649f1 made
// getTenantContext() derive tenant context from the signed JWT directly,
// because trusting a header on the grounds that a proxy overwrites it fails
// open the moment the proxy stops running -- which is exactly what happened:
// the matcher below matched no path, middleware never ran, and
// `curl -H "x-myra-tenant-id: 2" /api/loads` returned another tenant's rows
// with no credentials.
//
// So the forwarding is GONE rather than merely unused. A dead `set()` of a
// header that used to be an authorization input is a loaded gun: the next
// person to write `request.headers.get("x-myra-tenant-id")` in a handler
// resurrects the original bug. Instead, those four headers are now STRIPPED
// from every inbound request (see STRIPPED_REQUEST_HEADERS below), so there is
// nothing to resurrect.
//
// Verified 2026-10-08 that nothing reads them:
//   grep -rn "x-myra" app lib components scripts __tests__ tests
//                     ../../DApp "../../One_pager tracking"
// finds only comments, tests asserting they are ignored, and this file.
// ---------------------------------------------------------------------------

/**
 * Caller-supplied tenant-context headers. Stripped unconditionally, on every
 * path, before any branch in middleware() runs -- including public paths,
 * which is where a dead injection would have been most dangerous (no JWT is
 * required there, so a forged header would arrive pristine).
 *
 * Exported so __tests__/middleware-header-stripping.test.ts asserts the real
 * list rather than a copy of it.
 */
export const STRIPPED_REQUEST_HEADERS = [
  "x-myra-tenant-id",
  "x-myra-tenant-role",
  "x-myra-user-id",
  "x-myra-super-admin",
] as const

/**
 * Build the NextResponse.next() init that removes STRIPPED_REQUEST_HEADERS
 * from the request the route handler sees.
 *
 * Mechanism: NextResponse.next({ request: { headers } }) emits
 * `x-middleware-override-headers` plus one `x-middleware-request-<name>` per
 * key, and Next then DELETES every inbound header absent from that set
 * (next/dist/server/lib/router-utils/resolve-routes.js, "// Delete headers."
 * loop). Omitting a key therefore removes it -- this is Next's documented way
 * to delete a request header from middleware, not a side effect.
 *
 * Returns undefined when the request carries none of them, so the overwhelming
 * majority of real traffic keeps the exact plain-`NextResponse.next()` code
 * path it has today and only a request that actually attempts a forgery pays
 * for the header rewrite. That matters because enabling this middleware is a
 * one-way door.
 */
function stripForgeableHeaders(
  request: NextRequest,
): { request: { headers: Headers } } | undefined {
  const present = STRIPPED_REQUEST_HEADERS.filter((h) => request.headers.has(h))
  if (present.length === 0) return undefined
  const headers = new Headers(request.headers)
  for (const h of present) headers.delete(h)
  return { request: { headers } }
}

// ---------------------------------------------------------------------------
// Route protection middleware
// ---------------------------------------------------------------------------

// Public routes -- no auth needed.
// SECURITY NOTE: use exact equality or tightly scoped prefixes. An overly
// broad startsWith (e.g. "/api/drivers/") would accidentally bypass auth on
// all driver resource routes. The invite path is intentionally path-scoped.
export const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/driver-login",
  "/api/drivers/invite/",       // invite token lookup -- intentionally path-scoped
  "/api/drivers/accept-invite", // exact prefix, no trailing slash needed
  "/rate/",                     // public shipper delivery rating page
  "/api/rate/",                 // public rating submission endpoint
  "/invite/",                   // public invite acceptance page
  "/api/auth/accept-invite",    // public invite validation + account creation
] as const

// ---------------------------------------------------------------------------
// Routes that authenticate with something OTHER than a user JWT.
//
// Until 2026-10-08 the `config.matcher` below was malformed and matched no
// path, so this middleware had never run and this list had never been
// validated against real traffic. Turning middleware on makes every path it
// sees subject to verifyJwtEdge(), which would 401 callers that legitimately
// present a shared secret or an HMAC signature instead of a user JWT.
//
// EXACT EQUALITY ONLY, and every entry was read and confirmed to enforce its
// own credential inside the handler (verified 2026-10-08):
//   /api/cron/*            -> CRON_SECRET, Bearer (4 routes) or x-cron-secret
//                             (fmcsa-reverify, invoice-alerts, shipper-reports)
//   /api/pipeline/import   -> Bearer `PIPELINE_IMPORT_TOKEN || CRON_SECRET`
//   /api/webhooks/retell-* -> HMAC-SHA256 over the raw body, keyed by
//                             RETELL_WEBHOOK_SECRET / RETELL_API_KEY, with a
//                             5-minute timestamp window (verifyRetellSignature)
//   /api/health            -> intentionally unauthenticated liveness probe;
//                             returns latencies only, no rows and no secrets.
//                             Bypassed so uptime monitors keep working.
//
// DO NOT add an entry whose handler does not itself authenticate -- that turns
// a bypass into an open endpoint. Covered by the public-paths test, which
// derives the cron list from the filesystem so a newly added cron route fails
// the test until it is listed here.
// ---------------------------------------------------------------------------
export const SELF_AUTHENTICATING_PATHS = [
  // T-30. Route exists and checks CRON_SECRET itself; its schedule is held out
  // of vercel.json until migration 059 is applied to production.
  "/api/cron/contract-intake-finalize",
  "/api/cron/exception-bridge",
  "/api/cron/exception-detect",
  "/api/cron/feedback-aggregation",
  "/api/cron/fmcsa-reverify",
  "/api/cron/invoice-alerts",
  "/api/cron/pipeline-health",
  "/api/cron/pipeline-scan",
  "/api/cron/shipper-reports",
  "/api/pipeline/import",
  "/api/webhooks/retell-callback",
  "/api/health",
] as const

// Tracking routes -- token-in-path auth (resolved via resolveTrackingToken in
// handlers, NOT here). Tenant context attaches at handler level after token
// lookup, so these bypass cookie auth.
//
// This was a bare `/api/tracking/` prefix until 2026-10-08, which bypassed the
// WHOLE subtree -- but two routes under it are not token-in-path at all and
// authenticate as a normal user via getCurrentUser()/requireTenantContext():
//   /api/tracking/positions  GET, GPS positions for every load in the tenant
//                            (app/api/tracking/positions/route.ts:80-83)
//   /api/tracking/checkcall  POST, writes check_calls + activity_notes
//                            (app/api/tracking/checkcall/route.ts:6-9)
// Both are called from the broker UI with cookie auth (lib/api.ts:197,201,226),
// never with a tracking token. Post-Layer-1 there was no live hole -- those
// handlers derive tenant from the JWT -- but the bypass list documents itself
// as "every entry enforces its own credential", and these two did not, so the
// claim has to become true rather than be narrated.
//
// Built from the actual filesystem, not from a guess
// (`find app/api/tracking -name route.ts`, 2026-10-08):
//   app/api/tracking/[token]/route.ts            -> /api/tracking/<token>
//   app/api/tracking/[token]/documents/route.ts  -> .../documents
//   app/api/tracking/[token]/events/route.ts     -> .../events
//   app/api/tracking/[token]/sse/route.ts        -> .../sse
//   app/api/tracking/checkcall/route.ts          -> PROTECTED
//   app/api/tracking/positions/route.ts          -> PROTECTED
// The lookahead rejects those two names whether they end the path or carry a
// sub-segment, so /api/tracking/positions/documents cannot sneak in through
// the optional group. Any future sub-route under [token]/ defaults to
// PROTECTED, same contract as PUBLIC_CONFIRMATION_PATH below.
const PUBLIC_TRACKING_PATH =
  /^\/api\/tracking\/(?!positions(?:$|\/)|checkcall(?:$|\/))[^/]+(?:\/(?:documents|events|sse))?$/

// E2-04 shipper rate-confirmation routes: the token in the path IS the
// credential (same contract as /api/tracking/[token]). The token is dynamic so
// this cannot be exact equality -- but it is written as a strict ALLOWLIST of
// the three public shapes rather than a `/api/confirmations/` prefix, because
// a prefix would also bypass /api/confirmations/[token]/verbal, which is an
// authenticated ops override gated on role admin|owner|service_admin. Any
// future sub-route added under [token]/ therefore defaults to PROTECTED.
//   GET  /api/confirmations/<token>
//   POST /api/confirmations/<token>/confirm
//   POST /api/confirmations/<token>/decline
const PUBLIC_CONFIRMATION_PATH = /^\/api\/confirmations\/[^/]+(?:\/(?:confirm|decline))?$/

/**
 * True when middleware must let the request through without a user JWT.
 *
 * Exported so __tests__/middleware-public-paths.test.ts can assert the real
 * list instead of a copy of it.
 */
export function isPublicPath(pathname: string): boolean {
  if ((SELF_AUTHENTICATING_PATHS as readonly string[]).includes(pathname)) return true
  if ((PUBLIC_PATHS as readonly string[]).some((p) => pathname === p || pathname.startsWith(p))) {
    return true
  }
  if (PUBLIC_TRACKING_PATH.test(pathname)) return true
  if (PUBLIC_CONFIRMATION_PATH.test(pathname)) return true
  return false
}

// ---------------------------------------------------------------------------
// Driver allowlist -- the only API paths a driver JWT may reach.
//
// Written as an exact-match set plus ONE tightly bounded pattern for the
// /api/loads/<id> item routes, for the same reason PUBLIC_CONFIRMATION_PATH is
// an allowlist and not a prefix. The previous value matched with
// startsWith("/api/loads/"), whose blast radius was the entire loads subtree:
//   /api/loads/<id>/assign  and  /api/loads/<id>/match  call
//   requireTenantContext() with NO requireRole() check, so a driver token
//   could assign a carrier to -- or re-rank matches for -- any load in its
//   tenant. The prefix also admitted /api/loads/<id>/{invoice,send-tracking,
//   tracking-token,events,confirm-carrier-signature}, /api/loads/bulk-match
//   and /api/loads/map.
// Pre-existing, but middleware going live is the moment this list becomes the
// advertised driver boundary, so it is narrowed to the real DApp surface.
//
// Every entry is justified by a real DApp call site (re-verified 2026-10-08
// against DApp/ working tree; DApp/next.config.mjs rewrites /api/:path* 1:1,
// so MyraTMS sees these pathnames verbatim):
//   GET   /api/drivers/me/loads     DApp/app/page.tsx:56
//   GET   /api/documents            DApp/components/docs-screen.tsx:81
//                                   (?relatedType=Load)
//   POST  /api/loads/request        DApp/components/request-load.tsx:54
//   PATCH /api/loads/<id>           DApp/app/page.tsx:162,
//                                   DApp/components/request-load.tsx:97
//   POST  /api/loads/<id>/location  DApp/hooks/use-gps.ts:33 (+ the sw.js
//                                   background-sync replay of the same URL)
//   POST  /api/loads/<id>/pod       DApp/components/pod-capture.tsx:42
// /api/auth/me and /api/auth/logout are kept for every role: both are scoped
// to the caller's own session. /api/drivers/me is kept as the documented
// driver self-profile path; no route.ts exists for it today (only me/loads),
// so it 404s, but the entry is exact equality and therefore grants nothing.
//
// DELIBERATELY NOT LISTED: /api/documents/upload. DApp/components/
// docs-screen.tsx:132 POSTs /api/documents, which exports only GET and so
// 405s today -- a dead call. Do not widen middleware to make it work.
//
// NOTE: /api/documents is granted by EXACT equality. A startsWith prefix would
// also open /api/documents/rate-con/<pipelineLoadId>,
// /api/documents/terms-mismatches and /api/documents/intake-match-report.
// ---------------------------------------------------------------------------
export const DRIVER_ALLOWED_EXACT = [
  "/api/drivers/me",
  "/api/drivers/me/loads",
  "/api/documents",
  "/api/loads/request",
  "/api/auth/logout",
  "/api/auth/me",
] as const

// /api/loads/<id> plus the two sub-routes the DApp posts to. The negative
// lookahead keeps the STATIC siblings of [id] out -- they are route names, not
// load ids. middleware-public-paths.test.ts re-derives app/api/loads/* from
// disk, so a newly added static sibling fails the test until it is classified.
const DRIVER_LOAD_ITEM_PATH =
  /^\/api\/loads\/(?!bulk-match$|map$|request$)[^/]+(?:\/(?:location|pod))?$/

/**
 * True when a driver-role JWT may reach `pathname`.
 *
 * Exported so __tests__/middleware-public-paths.test.ts can assert the real
 * allowlist instead of a copy of it.
 */
export function isDriverAllowedPath(pathname: string): boolean {
  if ((DRIVER_ALLOWED_EXACT as readonly string[]).includes(pathname)) return true
  return DRIVER_LOAD_ITEM_PATH.test(pathname)
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Handle CORS preflight (OPTIONS) requests first
  if (request.method === "OPTIONS") {
    return handleCorsPreflight(request)
  }

  // Strip caller-supplied x-myra-* headers BEFORE any branch, so no path --
  // public, protected, page or API -- can hand a handler a forged tenant
  // header. See STRIPPED_REQUEST_HEADERS.
  const sanitized = stripForgeableHeaders(request)

  if (isPublicPath(pathname)) {
    return withCors(request, NextResponse.next(sanitized))
  }

  // Check for auth: cookie first, then Authorization Bearer header
  const cookieToken = request.cookies.get("auth-token")?.value
  const authHeader = request.headers.get("Authorization")
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null
  const token = cookieToken || bearerToken

  const isApi = pathname.startsWith("/api/")

  if (!token) {
    // API routes get a JSON 401
    if (isApi) {
      return withCors(
        request,
        NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      )
    }
    // Page routes redirect to login
    return NextResponse.redirect(new URL("/login", request.url))
  }

  // ---------------------------------------------------------------------------
  // Signature verification -- for PAGE routes as well as API routes.
  //
  // SECURITY FIX (1): replaced atob(token.split(".")[1]) with verifyJwtEdge().
  // The old code decoded the payload without checking the signature, so any
  // attacker-crafted JWT with an admin role claim would have passed this
  // check. verifyJwtEdge() performs a full HMAC-SHA256 signature verification
  // using JWT_SECRET before trusting any payload claim.
  //
  // SECURITY FIX (2), 2026-10-08: this used to sit INSIDE the
  // pathname.startsWith("/api/") branch, so a page route passed on the mere
  // PRESENCE of a non-empty auth-token cookie -- auth-token=garbage got you
  // past middleware. Harmless while app/rate/[token]/page.tsx is the only
  // server component and every other page is "use client" + SWR (whose
  // fetches 401 and redirect), but the first server component added under
  // /loads or /admin would have rendered tenant data for an unverified
  // cookie. Verifying here closes that before it can be introduced.
  //
  // FAILURE MODE MATTERS: an invalid cookie on a browser navigation must
  // redirect, not 401 -- a 401 on a top-level navigation shows a bare error
  // page with no way out, and the bad cookie would still be there on the next
  // attempt. So page routes get a redirect to /login AND the cookie is
  // cleared. No redirect loop is possible: "/login" is in PUBLIC_PATHS and
  // returns above, before any token is looked at. Same for the other public
  // pages (/rate/, /invite/).
  // ---------------------------------------------------------------------------
  const payload = await verifyJwtEdge(token)

  if (!payload) {
    if (isApi) {
      return withCors(
        request,
        NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      )
    }
    const redirect = NextResponse.redirect(new URL("/login", request.url))
    // Drop the unusable cookie so the next navigation is a clean anonymous
    // one. Matches the path ("/") it was set with.
    redirect.cookies.delete("auth-token")
    return redirect
  }

  // ---------------------------------------------------------------------------
  // Role-Based Access Control (RBAC): driver JWTs reach only the DApp surface.
  //
  // Scoped to API paths, as before. Page routes are deliberately NOT
  // driver-gated here: drivers use the DApp, never the MyraTMS pages, so no
  // driver has ever loaded one -- and adding a page-level 403 on the same
  // commit that turns middleware on is new blast radius for no proven gain.
  // ---------------------------------------------------------------------------
  if (isApi && payload.role === "driver" && !isDriverAllowedPath(pathname)) {
    return withCors(
      request,
      NextResponse.json({ error: "Forbidden" }, { status: 403 })
    )
  }

  // No tenant headers are injected any more -- handlers derive tenant context
  // from the signed JWT via lib/auth.ts getTenantContext(). See the
  // "Tenant resolution (ADR-002) -- NOT done here any more" note above.
  return withCors(request, NextResponse.next(sanitized))
}

// Matcher: everything except Next's static assets and any path containing a
// dot (i.e. a file request). Covered by __tests__/middleware-matcher.test.ts,
// which compiles this with Next's own getMiddlewareMatchers and asserts that
// real routes match.
//
// The previous value, "/((?!_next/static|_next/image|favicon.ico|.*\..*).*))",
// had TWO independent bugs and matched NO path at all, so this entire
// middleware never ran in production:
//   1. an unbalanced trailing paren, which became a literal ")" in the regex;
//   2. "\." inside a double-quoted TS string is not an escape -- it collapses
//      to ".", so ".*..*" matched any path of 2+ characters and the negative
//      lookahead rejected everything.
// A literal dot is written [.] here precisely so no string-escape layer can
// eat it again. Do not hand-edit this without running the test.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*[.].*).*)"],
}
