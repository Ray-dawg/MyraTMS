import { NextResponse } from "next/server"

/**
 * Standardized API error response.
 * New routes should use this; existing routes can adopt gradually.
 *
 * @param message - Human-readable error message
 * @param status  - HTTP status code (default 400)
 * @param details - Optional additional error details (validation errors, etc.)
 */
export function apiError(message: string, status: number = 400, details?: unknown) {
  return NextResponse.json(
    { error: message, ...(details ? { details } : {}) },
    { status }
  )
}
