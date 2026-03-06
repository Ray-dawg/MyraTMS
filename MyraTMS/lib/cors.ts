import { NextRequest, NextResponse } from "next/server"

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

/**
 * Returns the origin if it's in the allow list, or empty string if not.
 */
function getAllowedOrigin(request: NextRequest): string {
  const origin = request.headers.get("origin") || ""
  if (ALLOWED_ORIGINS.includes(origin)) {
    return origin
  }
  return ""
}

/**
 * Add CORS headers to an existing NextResponse.
 * Use this in your API route handlers after building the response.
 */
export function withCors(response: NextResponse, request: NextRequest): NextResponse {
  const origin = getAllowedOrigin(request)
  if (origin) {
    response.headers.set("Access-Control-Allow-Origin", origin)
    response.headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS)
    response.headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS)
    response.headers.set("Access-Control-Allow-Credentials", "true")
    response.headers.set("Access-Control-Max-Age", "86400")
  }
  return response
}

/**
 * Handle CORS preflight (OPTIONS) requests.
 * Use this in middleware or as an OPTIONS route export.
 */
export function handleCorsPreflight(request: NextRequest): NextResponse {
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
