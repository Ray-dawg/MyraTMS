import type { NextRequest } from 'next/server';
import { getCurrentUser, requireRole, type JwtPayload } from '@/lib/auth';
import { apiError } from '@/lib/api-error';

export function authorizeGovernanceRequest(req: NextRequest): { user: JwtPayload } | { error: Response } {
  const user = getCurrentUser(req);
  if (!user) return { error: apiError('Unauthorized', 401) };
  const denied = requireRole(user, 'admin', 'ops');
  if (denied) return { error: denied };
  return { user };
}

export function resolveTenantId(searchParams: URLSearchParams, user: JwtPayload): number {
  const requested = searchParams.get('tenant_id');
  if (requested && user.isSuperAdmin) {
    const parsed = Number(requested);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return user.tenantId;
}
