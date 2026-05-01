/**
 * LoadBoard123Adapter — STUB. Same interface as DAT; selectors differ.
 */

import type { BrowserContext, Page } from 'playwright';
import { BaseAdapter, type AuthResult, type SearchQuery, type ParsedRow } from '../base.js';

export class LoadBoard123Adapter extends BaseAdapter {
  readonly source = '123lb' as const;

  async authenticate(_context: BrowserContext): Promise<AuthResult> {
    throw new Error('LoadBoard123Adapter.authenticate() not yet implemented');
  }

  async search(_page: Page, _query: SearchQuery): Promise<Page> {
    throw new Error('LoadBoard123Adapter.search() not yet implemented');
  }

  async parseResult(_page: Page): Promise<ParsedRow[]> {
    throw new Error('LoadBoard123Adapter.parseResult() not yet implemented');
  }
}
