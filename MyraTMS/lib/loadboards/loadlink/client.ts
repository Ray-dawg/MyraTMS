/**
 * LoadlinkAPIClient — STUB.
 *
 * Loadlink (Canadian Trucking Alliance) historically uses SOAP. When
 * credentials arrive, you have two options:
 *   (a) Add a SOAP client like `strong-soap` and parse XML responses
 *   (b) Find out if Loadlink has shipped a REST endpoint since this spec
 *       was written and use it instead
 *
 * Either way, the LoadBoardAPIClient interface is HTTP-agnostic — only
 * the searchLoads() body changes.
 */

import {
  type AuthHandle,
  type LoadBoardAPIClient,
  type SearchQuery,
  LoadBoardAPIError,
} from '../base';
import type { RawLoad } from '@/lib/workers/scanner-worker';
import { mapLoadlinkToRawLoad } from './mapper';

export class LoadlinkAPIClient implements LoadBoardAPIClient {
  readonly source = 'loadlink' as const;

  async authenticate(): Promise<AuthHandle> {
    throw new LoadBoardAPIError('loadlink', 'not_implemented', 'Loadlink API client not yet implemented', false);
  }

  async searchLoads(_query: SearchQuery, _auth: AuthHandle): Promise<unknown[]> {
    throw new LoadBoardAPIError('loadlink', 'not_implemented', 'Loadlink API client not yet implemented', false);
  }

  mapToRawLoad(apiRow: unknown): RawLoad | null {
    return mapLoadlinkToRawLoad(apiRow);
  }
}
