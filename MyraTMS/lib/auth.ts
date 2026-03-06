// ---------------------------------------------------------------------------
// Auth utilities for MyraTMS
//
// To get the current user in API routes:
//   import { getCurrentUser } from "@/lib/auth"
//   const user = getCurrentUser(request)
//   // user.firstName, user.lastName, user.email, user.role, user.userId
//   // Use `${user.firstName} ${user.lastName}` instead of hardcoded "Sarah Chen"
//
// The middleware (middleware.ts) ensures all non-public routes have a valid
// auth-token cookie, so getCurrentUser() will only return null if the token
// has been tampered with or the secret has rotated.
// ---------------------------------------------------------------------------

import jwt from "jsonwebtoken"
import bcrypt from "bcryptjs"
import { NextRequest } from "next/server"

export interface JwtPayload {
  userId: string
  email: string
  role: string
  firstName: string
  lastName: string
  carrierId?: string
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is not set")
  }
  return secret
}

export function createToken(
  payload: {
    userId: string
    email: string
    role: string
    firstName: string
    lastName: string
    carrierId?: string
  },
  expiresIn: string = "24h"
): string {
  return jwt.sign({ ...payload } as Record<string, unknown>, getJwtSecret(), { expiresIn: expiresIn as unknown as number })
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as JwtPayload
    return decoded
  } catch {
    return null
  }
}

export function getCurrentUser(request: NextRequest): JwtPayload | null {
  // Check cookie first, then Authorization Bearer header (for cross-origin Driver App)
  const cookieToken = request.cookies.get("auth-token")?.value
  const authHeader = request.headers.get("Authorization")
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null
  const token = cookieToken || bearerToken
  if (!token) {
    return null
  }
  return verifyToken(token)
}

/**
 * Require specific roles. Returns an error response if the user's role is not allowed.
 * Usage: const denied = requireRole(user, 'admin', 'ops', 'sales'); if (denied) return denied;
 */
export function requireRole(
  user: JwtPayload,
  ...allowedRoles: string[]
): Response | null {
  if (allowedRoles.includes(user.role)) return null
  return new Response(JSON.stringify({ error: "Forbidden" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  })
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

export async function comparePassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash)
}
