/**
 * DAT OAuth2 token cache — STUB.
 *
 * When the credentials arrive, this becomes a Redis-backed token cache:
 *
 *   1. Read `loadboard:dat:token` from Redis. If present and not near
 *      expiry, return it.
 *   2. Otherwise hit DAT's auth endpoint with client_credentials grant.
 *   3. Cache the access_token under `loadboard:dat:token` with TTL =
 *      expires_in - 60 (refresh 60s before actual expiry).
 *   4. Return the new token.
 *
 * The integrations row (provider='dat_api') holds:
 *   - api_key    → client_id
 *   - api_secret → client_secret
 *   - config jsonb → { auth_url, base_url, customer_id, ... }
 */

import { LoadBoardAPIError } from '../base';

export async function getDATToken(): Promise<string> {
  throw new LoadBoardAPIError(
    'dat',
    'not_implemented',
    'DAT OAuth not yet implemented — populate integrations.dat_api and implement this',
    false,
  );
}
