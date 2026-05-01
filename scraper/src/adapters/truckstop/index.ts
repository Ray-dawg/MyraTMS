/**
 * TruckstopAdapter — STUB. Replace when scraping is needed.
 *
 * Same interface as DAT; selectors and login flow will differ. When the
 * Truckstop API key arrives, retire this adapter and use the API path in
 * MyraTMS/lib/workers/scanner-worker.ts instead.
 */

import type { BrowserContext, Page } from 'playwright';
import { BaseAdapter, type AuthResult, type SearchQuery, type ParsedRow } from '../base.js';

export class TruckstopAdapter extends BaseAdapter {
  readonly source = 'truckstop' as const;

  async authenticate(_context: BrowserContext): Promise<AuthResult> {
    throw new Error('TruckstopAdapter.authenticate() not yet implemented');
  }

  async search(_page: Page, _query: SearchQuery): Promise<Page> {
    throw new Error('TruckstopAdapter.search() not yet implemented');
  }

  async parseResult(_page: Page): Promise<ParsedRow[]> {
    throw new Error('TruckstopAdapter.parseResult() not yet implemented');
  }
}
