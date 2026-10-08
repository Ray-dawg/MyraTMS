// ---------------------------------------------------------------------------
// Auth utilities for MyraTMS
//
// To get the current user in API routes:
//   import { getCurrentUser } from "@/lib/auth"
//   const user = getCurrentUser(request)
//   // user.firstName, user.lastName, user.email, user.role, user.userId
//   // user.tenantId — the active tenant for this session
//
// The middleware (middleware.ts) ensures all non-public routes have a valid
// auth-token cookie, so getCurrentUser() will only return null if the token
// has been tampered with or the secret has rotated.
//
// Multi-tenant (Phase 2.3, 2026-05-01):
//   JwtPayload now includes tenantId / tenantIds / isSuperAdmin per ADR-002.
//   Legacy tokens (issued before this deploy) lack these fields; getCurrentUser
//   backfills them with the Myra default per ADR-004 backwards-compat strategy.
//   The backfill is removed in Phase M4 once all tokens have rotated.
// ---------------------------------------------------------------------------

import jwt from "jsonwebtoken"
import bcrypt from "bcryptjs"
import { NextRequest } from "next/server"

/**
 * The Myra tenant id, established by migration 027 (BIGSERIAL after the
 * `_system` tenant which gets id=1). Used as the backwards-compat default
 * for JWTs that predate the tenant_id claim. Removed in Phase M4.
 */
export const LEGACY_DEFAULT_TENANT_ID = 2

export interface JwtPayload {
  userId: string
  email: string
  role: string
  firstName: string
  lastName: string
  carrierId?: string
  /** Active tenant for this session. Required post-Phase-M4. */
  tenantId: number
  /** All tenants this user belongs to. Length 1 for single-tenant users. */
  tenantIds: number[]
  /**
   * True if this user can operate cross-tenant via subdomain navigation.
   * Granted only via direct DB write or super-admin UI (Phase 5.5).
   */
  isSuperAdmin?: boolean
}

/**
 * The shape of a legacy token (pre-Phase-2.3). Used internally for
 * backwards-compat backfill. Don't export this.
 */
type LegacyJwtPayload = Omit<JwtPayload, "tenantId" | "tenantIds"> &
  Partial<Pick<JwtPayload, "tenantId" | "tenantIds">>

/**
 * Backfill missing tenant fields on a decoded payload. Used both at sign
 * time (createToken with no tenantId provided) and verify time (verifyToken
 * decoding a legacy token). Idempotent.
 */
function backfillTenantClaims(payload: LegacyJwtPayload): JwtPayload {
  const tenantId =
    typeof payload.tenantId === "number"
      ? payload.tenantId
      : LEGACY_DEFAULT_TENANT_ID
  const tenantIds =
    Array.isArray(payload.tenantIds) && payload.tenantIds.length > 0
      ? payload.tenantIds
      : [tenantId]
  return { ...payload, tenantId, tenantIds }
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
    tenantId?: number
    tenantIds?: number[]
    isSuperAdmin?: boolean
  },
  expiresIn: string = "24h"
): string {
  // Backfill missing tenant fields with the legacy default. New code should
  // always provide tenantId/tenantIds explicitly; this safety net protects
  // older callers during the Phase 2.3 rollout (per ADR-004 §M2d).
  const fullPayload = backfillTenantClaims(payload as LegacyJwtPayload)
  return jwt.sign({ ...fullPayload } as Record<string, unknown>, getJwtSecret(), {
    expiresIn: expiresIn as unknown as number,
  })
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as LegacyJwtPayload
    // Backfill missing tenant fields for legacy tokens issued before Phase 2.3.
    return backfillTenantClaims(decoded)
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
 * Tenant context for a request (ADR-002). Route handlers MUST read tenant
 * context through this helper so the resolution order stays in one place.
 *
 * SECURITY: resolved from the signed JWT, never from request headers.
 *
 * This used to read the x-myra-tenant-* headers that middleware.ts injects,
 * trusting middleware to overwrite anything a client sent. On 2026-10-08 the
 * middleware `matcher` was found to be malformed (an unbalanced paren made it
 * match no path at all), so middleware had never run in production — and a
 * plain `curl -H "x-myra-tenant-id: 2" /api/loads` returned another tenant's
 * rows with no credentials at all.
 *
 * Trusting a header because a proxy is supposed to overwrite it fails open the
 * moment the proxy stops running. Deriving from the JWT cannot: forging it
 * requires JWT_SECRET. Nothing in app/, lib/, DApp/ or One_pager reads an
 * x-myra-* header any more (verified by grep, 2026-10-09) -- middleware is
 * still not routing, so nothing sets them either.
 *
 * Returns null when the request carries no valid token.
 */
export interface TenantContext {
  tenantId: number
  role: string
  userId: string
  isSuperAdmin: boolean
}

export function getTenantContext(request: NextRequest): TenantContext | null {
  const user = getCurrentUser(request)
  if (!user) return null
  const tenantId = Number(user.tenantId)
  if (!Number.isInteger(tenantId) || tenantId <= 0) return null
  return {
    tenantId,
    role: user.role,
    userId: user.userId,
    isSuperAdmin: user.isSuperAdmin === true,
  }
}

/**
 * Same as getTenantContext but throws when the request is unauthenticated.
 * Callers that want to answer 401 should use getTenantContext and branch.
 */
export function requireTenantContext(request: NextRequest): TenantContext {
  const ctx = getTenantContext(request)
  if (ctx) return ctx
  throw new Error("requireTenantContext: no valid JWT on request")
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

/**
 * Gate cross-tenant admin endpoints. Returns 401 if no JWT, 403 if the
 * caller is not flagged as super-admin. Use BEFORE invoking asServiceAdmin
 * so unauthorized callers never trigger the audit log.
 *
 * Returns null (allowed) or a Response (blocked).
 */
export function requireSuperAdmin(request: NextRequest): Response | null {
  const user = getCurrentUser(request)
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }
  if (!user.isSuperAdmin) {
    return new Response(JSON.stringify({ error: "Forbidden — super-admin only" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })
  }
  return null
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
