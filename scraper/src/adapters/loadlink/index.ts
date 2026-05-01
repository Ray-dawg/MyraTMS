/**
 * LoadlinkAdapter — STUB. Same interface as DAT; selectors differ.
 */

import type { BrowserContext, Page } from 'playwright';
import { BaseAdapter, type AuthResult, type SearchQuery, type ParsedRow } from '../base.js';

export class LoadlinkAdapter extends BaseAdapter {
  readonly source = 'loadlink' as const;

  async authenticate(_context: BrowserContext): Promise<AuthResult> {
    throw new Error('LoadlinkAdapter.authenticate() not yet implemented');
  }

  async search(_page: Page, _query: SearchQuery): Promise<Page> {
    throw new Error('LoadlinkAdapter.search() not yet implemented');
  }

  async parseResult(_page: Page): Promise<ParsedRow[]> {
    throw new Error('LoadlinkAdapter.parseResult() not yet implemented');
  }
}
