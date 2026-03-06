import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

// ---------------------------------------------------------------------------
// CORS configuration (inlined because middleware runs in Edge runtime and
// cannot use standard @/lib imports)
// ---------------------------------------------------------------------------

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

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Handle CORS preflight (OPTIONS) requests first
  if (request.method === "OPTIONS") {
    return handleCorsPreflight(request)
  }

  // Public routes -- no auth needed
  const publicPaths = ["/login", "/api/auth/login", "/api/auth/driver-login"]
  const isPublic = publicPaths.some((p) => pathname.startsWith(p))

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
  // We decode the JWT payload (base64) without verifying signature here —
  // full verification happens in getCurrentUser() inside the route handler.
  // ---------------------------------------------------------------------------
  if (pathname.startsWith("/api/")) {
    try {
      const payloadB64 = token.split(".")[1]
      if (payloadB64) {
        const payload = JSON.parse(atob(payloadB64))
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
    } catch {
      // If JWT decode fails, let the route handler deal with it
    }
  }

  const response = NextResponse.next()
  return withCors(request, response)
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
}
