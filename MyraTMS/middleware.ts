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

  // Tracking routes -- token-based auth, not cookie
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
  // Role-Based Access Control (RBAC)
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
  }

  const response = NextResponse.next()
  return withCors(request, response)
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\..*).*))"],
}
