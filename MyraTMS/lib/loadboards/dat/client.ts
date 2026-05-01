/**
 * DATAPIClient — STUB.
 *
 * DAT Power uses OAuth2 client-credentials flow; the public API is
 * REST/JSON. When the credentials arrive:
 *   1. Add `dat_api` row to `integrations` table with api_key=<client_id>,
 *      api_secret=<client_secret>, config={ base_url, auth_url, customer_id }.
 *   2. Replace the body of authenticate() with the real OAuth flow
 *      (see ./oauth.ts which is also a stub at this point).
 *   3. Replace the body of searchLoads() with the actual /loads search call.
 *   4. Replace the body of mapToRawLoad() in ./mapper.ts.
 *   5. UPDATE loadboard_sources SET ingest_method='api', integration_id=<uuid>
 *      WHERE source='dat'.
 *
 * Until then, this throws 'not_implemented' on every call. The cron
 * orchestrator catches the typed error and skips the source cleanly —
 * doesn't crash the dispatcher, doesn't wedge the queue.
 */

import {
  type AuthHandle,
  type LoadBoardAPIClient,
  type SearchQuery,
  LoadBoardAPIError,
} from '../base';
import type { RawLoad } from '@/lib/workers/scanner-worker';
import { mapDATToRawLoad } from './mapper';

export class DATAPIClient implements LoadBoardAPIClient {
  readonly source = 'dat' as const;

  async authenticate(): Promise<AuthHandle> {
    throw new LoadBoardAPIError(
      'dat',
      'not_implemented',
      'DAT API client not yet implemented — populate integrations.dat_api credentials and replace this stub',
      false,
    );
  }

  async searchLoads(_query: SearchQuery, _auth: AuthHandle): Promise<unknown[]> {
    throw new LoadBoardAPIError(
      'dat',
      'not_implemented',
      'DAT API client not yet implemented',
      false,
    );
  }

  mapToRawLoad(apiRow: unknown): RawLoad | null {
    return mapDATToRawLoad(apiRow);
  }
}
