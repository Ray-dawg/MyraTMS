/**
 * TruckstopAPIClient — STUB.
 *
 * Truckstop.com publishes a REST API ("Truckstop Load Search API")
 * authenticated via API key in a header. When credentials arrive, follow
 * the same pattern as the DAT client:
 *   - Add `truckstop_api` row to integrations
 *   - Replace authenticate() to build the API-key handle synchronously
 *   - Replace searchLoads() with the /loads search endpoint
 *   - Implement mapToRawLoad in ./mapper.ts
 *   - Flip loadboard_sources.truckstop to ingest_method='api'
 */

import {
  type AuthHandle,
  type LoadBoardAPIClient,
  type SearchQuery,
  LoadBoardAPIError,
} from '../base';
import type { RawLoad } from '@/lib/workers/scanner-worker';
import { mapTruckstopToRawLoad } from './mapper';

export class TruckstopAPIClient implements LoadBoardAPIClient {
  readonly source = 'truckstop' as const;

  async authenticate(): Promise<AuthHandle> {
    throw new LoadBoardAPIError(
      'truckstop',
      'not_implemented',
      'Truckstop API client not yet implemented',
      false,
    );
  }

  async searchLoads(_query: SearchQuery, _auth: AuthHandle): Promise<unknown[]> {
    throw new LoadBoardAPIError('truckstop', 'not_implemented', 'Truckstop API client not yet implemented', false);
  }

  mapToRawLoad(apiRow: unknown): RawLoad | null {
    return mapTruckstopToRawLoad(apiRow);
  }
}
