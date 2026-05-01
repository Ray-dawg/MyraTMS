/**
 * LoadBoardAdapter contract — the only thing each board has to implement.
 * Everything else (browser pool, session store, scheduler, dedup, DB write,
 * queue enqueue) is shared.
 *
 * Three async functions:
 *   authenticate() — establish a session (or reuse one)
 *   search()       — drive the search UI to the results page
 *   parseResult()  — pull rows from the results page into ParsedRow[]
 *
 * Adding a new board = implementing this interface only.
 */

import type { BrowserContext, Page } from 'playwright';

export type LoadBoardSource = 'dat' | 'truckstop' | '123lb' | 'loadlink';

export interface SearchQuery {
  equipmentTypes: Array<'dry_van' | 'flatbed' | 'reefer' | 'tanker' | 'step_deck'>;
  originProvinces: string[]; // e.g. ['ON', 'AB']
  pickupDateFrom: Date;
  pickupDateTo: Date;
  originRadiusMiles?: number;
  destinationRadiusMiles?: number;
}

export interface AuthResult {
  success: boolean;
  reason?: 'invalid_credentials' | 'mfa_required' | 'captcha' | 'rate_limited' | 'unknown';
  detail?: string;
  sessionReused?: boolean;
}

/**
 * Adapter-specific row shape — pre-normalization. The pipeline/normalize.ts
 * layer maps this to RawLoad.
 *
 * Common metadata fields are typed; any source-specific cells stay loose.
 */
export interface ParsedRow {
  __source: LoadBoardSource;
  __scrapedAt: string; // ISO
  [key: string]: unknown;
}

export interface LoadBoardAdapter {
  readonly source: LoadBoardSource;

  /**
   * Establish an authenticated session. Should attempt session reuse from
   * Redis first; falls back to login. Returns success=false with a typed
   * reason on auth failures — does not throw.
   */
  authenticate(context: BrowserContext): Promise<AuthResult>;

  /**
   * Drive the search UI using the authenticated context. Returns the page
   * positioned at the results.
   */
  search(page: Page, query: SearchQuery): Promise<Page>;

  /**
   * Parse the current page's results into structured rows. Should NOT
   * normalize to RawLoad — the pipeline layer does that. Pagination is
   * handled internally if present, with a hard cap.
   */
  parseResult(page: Page): Promise<ParsedRow[]>;
}

/**
 * Optional shared helpers — adapters may extend this to inherit human-like
 * timing utilities. Doesn't add behavior beyond the interface.
 */
export abstract class BaseAdapter implements LoadBoardAdapter {
  abstract readonly source: LoadBoardSource;
  abstract authenticate(context: BrowserContext): Promise<AuthResult>;
  abstract search(page: Page, query: SearchQuery): Promise<Page>;
  abstract parseResult(page: Page): Promise<ParsedRow[]>;

  protected async humanDelay(min = 800, max = 2400): Promise<void> {
    const ms = min + Math.random() * (max - min);
    await new Promise((r) => setTimeout(r, ms));
  }

  protected async humanType(page: Page, selector: string, text: string): Promise<void> {
    await page.click(selector);
    for (const ch of text) {
      await page.keyboard.type(ch, { delay: 50 + Math.random() * 80 });
    }
  }
}
