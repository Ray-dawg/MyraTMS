import type { NextRequest } from 'next/server';
import { getCurrentUser, requireRole, type JwtPayload } from '@/lib/auth';
import { apiError } from '@/lib/api-error';

/**
 * Same auth pattern as every other operator-facing route (e.g.
 * app/api/loadboard-sources/route.ts) — JWT cookie + role check, not the
 * bearer-token pattern used by the machine-to-machine /api/pipeline/import.
 */
export function authorizeEventsRequest(req: NextRequest): { user: JwtPayload } | { error: Response } {
  const user = getCurrentUser(req);
  if (!user) return { error: apiError('Unauthorized', 401) };
  const denied = requireRole(user, 'admin', 'ops');
  if (denied) return { error: denied };
  return { user };
}

/** tenant_id defaults to the caller's own tenant; only super-admins may cross tenants via ?tenant_id=. */
export function resolveTenantId(searchParams: URLSearchParams, user: JwtPayload): number {
  const requested = searchParams.get('tenant_id');
  if (requested && user.isSuperAdmin) {
    const parsed = Number(requested);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return user.tenantId;
}

export function clampLimit(raw: string | null, fallback = 100, max = 500): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function resolveWindowDays(raw: string | null): number {
  if (raw === '7d') return 7;
  if (raw === '90d') return 90;
  return 30;
}
