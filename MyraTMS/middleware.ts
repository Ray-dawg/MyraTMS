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
// Tenant resolution (ADR-002)
// ---------------------------------------------------------------------------
// Phase 2.3 (2026-05-01): JWT > service header > tracking token > subdomain.
// For Phase 1 there's only one domain (myra.myraos.ca / app.myraos.ca), so
// JWT is effectively the only source. Subdomain-driven resolution lights up
// in Session 6 when whitelabel custom domains arrive.
//
// Forwarded headers for downstream handlers:
//   x-myra-tenant-id       — numeric tenant id
//   x-myra-tenant-role     — JWT role claim (owner|admin|operator|driver|...)
//   x-myra-user-id         — JWT userId claim
//   x-myra-super-admin     — '1' if isSuperAdmin claim set, else absent
// Read via lib/auth.ts getTenantContext(request) helper.

const LEGACY_DEFAULT_TENANT_ID = 2 // myra tenant id (mirrors lib/auth.ts)

function resolveTenantIdFromPayload(
  payload: Record<string, unknown>,
): number {
  const claim = payload.tenantId
  if (typeof claim === "number" && Number.isInteger(claim) && claim > 0) {
    return claim
  }
  // Legacy token (predates Phase 2.3 deploy) — backfill per ADR-004 §M2d.
  return LEGACY_DEFAULT_TENANT_ID
}

// ---------------------------------------------------------------------------
// Route protection middleware
// ---------------------------------------------------------------------------

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Handle CORS preflight (OPTIONS) requests first
  if (request.method === "OPTIONS") {
    return handleCorsPreflight(request)
  }

  // Public routes -- no auth needed.
  // SECURITY NOTE: use exact equality or tightly scoped prefixes. An overly
  // broad startsWith (e.g. "/api/drivers/") would accidentally bypass auth on
  // all driver resource routes. The invite path is intentionally path-scoped.
  const publicPaths = [
    "/login",
    "/api/auth/login",
    "/api/auth/driver-login",
    "/api/drivers/invite/",       // invite token lookup -- intentionally path-scoped
    "/api/drivers/accept-invite", // exact prefix, no trailing slash needed
    "/rate/",                     // public shipper delivery rating page
    "/api/rate/",                 // public rating submission endpoint
    "/invite/",                   // public invite acceptance page
    "/api/auth/accept-invite",    // public invite validation + account creation
  ]
  const isPublic = publicPaths.some((p) => pathname === p || pathname.startsWith(p))

  // Tracking routes -- token-based auth (resolved via resolveTrackingToken
  // in handlers, NOT here). Tenant context attaches at handler level after
  // token lookup. Bypass cookie-auth and tenant-header injection.
  const isTracking = pathname.startsWith("/api/tracking/")

  if (isPublic || isTracking) {
    return withCors(request, NextResponse.next())
  }

  // Check for auth: cookie first, then Authorization Bearer header
  const cookieToken = request.cookies.get("auth-token")?.value
  const authHeader = request.headers.get("Authorization")
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null
  const token = cookieToken || bearerToken

  if (!token) {
    // API routes get a JSON 401
    if (pathname.startsWith("/api/")) {
      return withCors(
        request,
        NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      )
    }
    // Page routes redirect to login
    return NextResponse.redirect(new URL("/login", request.url))
  }

  // ---------------------------------------------------------------------------
  // Role-Based Access Control (RBAC) + Tenant resolution (ADR-002)
  // Driver JWTs can only access driver-specific API routes.
  //
  // SECURITY FIX: replaced atob(token.split('.')[1]) with verifyJwtEdge().
  // The old code decoded the payload without checking the signature, so any
  // attacker-crafted JWT with role:"admin" would have passed this check.
  // verifyJwtEdge() performs a full HMAC-SHA256 signature verification using
  // JWT_SECRET before trusting any payload claim.
  // ---------------------------------------------------------------------------
  if (pathname.startsWith("/api/")) {
    const payload = await verifyJwtEdge(token)

    // Reject tokens that fail signature verification or are expired, rather
    // than silently falling through to the route handler.
    if (!payload) {
      return withCors(
        request,
        NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      )
    }

    if (payload.role === "driver") {
      // Drivers can ONLY access these API paths
      const driverAllowed = [
        "/api/drivers/me",
        "/api/loads/",           // GET single load + PATCH status + POST location/pod/events
        "/api/auth/logout",
        "/api/auth/me",
      ]
      const isAllowed = driverAllowed.some((p) => pathname.startsWith(p))
      if (!isAllowed) {
        return withCors(
          request,
          NextResponse.json({ error: "Forbidden" }, { status: 403 })
        )
      }
    }

    // ----- Tenant resolution -----
    // Inject resolved tenant context into request headers for downstream
    // route handlers. Read via lib/auth.ts getTenantContext(request).
    const tenantId = resolveTenantIdFromPayload(payload)
    const role = typeof payload.role === "string" ? payload.role : ""
    const userId = typeof payload.userId === "string" ? payload.userId : ""
    const isSuperAdmin = payload.isSuperAdmin === true

    const requestHeaders = new Headers(request.headers)
    requestHeaders.set("x-myra-tenant-id", String(tenantId))
    requestHeaders.set("x-myra-tenant-role", role)
    requestHeaders.set("x-myra-user-id", userId)
    if (isSuperAdmin) requestHeaders.set("x-myra-super-admin", "1")

    return withCors(
      request,
      NextResponse.next({ request: { headers: requestHeaders } }),
    )
  }

  const response = NextResponse.next()
  return withCors(request, response)
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\..*).*))"],
}
