/**
 * Service-token helper for the Dispatcher (Agent 7).
 *
 * Mints a short-lived JWT signed with the same JWT_SECRET the rest of the
 * platform uses, so it passes through middleware.ts (Edge HMAC verifier) and
 * resolves via getCurrentUser() in the existing TMS API routes that the
 * Dispatcher needs to call:
 *   POST /api/loads
 *   POST /api/loads/[id]/assign
 *   POST /api/loads/[id]/tracking-token
 *   POST /api/loads/[id]/send-tracking
 *
 * The token's user identity is `system / system@myra.ai / admin` so the
 * TMS routes accept it (loads.ts requires user, no specific role check).
 *
 * Auth pattern: send as `Cookie: auth-token=<jwt>` — the same header the
 * browser uses for human users. Bearer header would also work but cookie
 * matches the existing prebuilt Dispatcher code path.
 */

import { createToken } from '@/lib/auth';

const SERVICE_USER = {
  userId: 'system',
  email: 'system@myra.ai',
  role: 'admin',
  firstName: 'Engine 2',
  lastName: 'Dispatcher',
};

/**
 * Mint a service JWT. Default lifetime is 5 minutes — long enough for
 * the 4-step Dispatcher chain (POST loads → assign → tracking-token →
 * send-tracking) plus retries, short enough that a leaked token can't be
 * abused for long.
 */
export function signServiceToken(expiresIn: string = '5m'): string {
  return createToken(SERVICE_USER, expiresIn);
}

/**
 * Convenience: produce the Cookie header value the Dispatcher attaches
 * to its outbound fetch() calls.
 */
export function serviceCookieHeader(expiresIn: string = '5m'): string {
  return `auth-token=${signServiceToken(expiresIn)}`;
}
