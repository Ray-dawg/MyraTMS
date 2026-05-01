/**
 * LoadBoard123APIClient — STUB.
 *
 * 123Loadboard publishes a REST API authenticated via OAuth2 bearer
 * tokens. Same pattern as DAT when credentials arrive.
 */

import {
  type AuthHandle,
  type LoadBoardAPIClient,
  type SearchQuery,
  LoadBoardAPIError,
} from '../base';
import type { RawLoad } from '@/lib/workers/scanner-worker';
import { mapLoadBoard123ToRawLoad } from './mapper';

export class LoadBoard123APIClient implements LoadBoardAPIClient {
  readonly source = '123lb' as const;

  async authenticate(): Promise<AuthHandle> {
    throw new LoadBoardAPIError('123lb', 'not_implemented', '123LB API client not yet implemented', false);
  }

  async searchLoads(_query: SearchQuery, _auth: AuthHandle): Promise<unknown[]> {
    throw new LoadBoardAPIError('123lb', 'not_implemented', '123LB API client not yet implemented', false);
  }

  mapToRawLoad(apiRow: unknown): RawLoad | null {
    return mapLoadBoard123ToRawLoad(apiRow);
  }
}
