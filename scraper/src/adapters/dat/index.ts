/**
 * DATAdapter — the only fully-implemented adapter in v1.
 *
 * Wires:
 *   authenticate() → ./login.ts authenticateDAT()
 *   search()       → drives the DAT search UI (this file)
 *   parseResult()  → ./parse.ts parseDATResults()
 *
 * Equipment label mapping note: DAT typically uses human-readable labels
 * ("Vans, Dry") in its multi-select. We map our normalized values
 * ("dry_van") → DAT label here. If DAT changes labels, update the map.
 */

import type { BrowserContext, Page } from 'playwright';
import { BaseAdapter, type AuthResult, type SearchQuery, type ParsedRow } from '../base.js';
import { authenticateDAT } from './login.js';
import { parseDATResults } from './parse.js';
import { DAT_SELECTORS } from './selectors.js';
import { config } from '../../config.js';
import { logger } from '../../observability/logger.js';

const DAT_EQUIPMENT_MAP: Record<string, string> = {
  dry_van: 'Vans, Dry',
  flatbed: 'Flatbeds',
  reefer: 'Vans, Reefer',
  tanker: 'Tankers',
  step_deck: 'Step Decks',
};

const SEARCH_RESULTS_TIMEOUT_MS = 20_000;
const SPINNER_TIMEOUT_MS = 15_000;

export class DATAdapter extends BaseAdapter {
  readonly source = 'dat' as const;

  async authenticate(context: BrowserContext): Promise<AuthResult> {
    return authenticateDAT(context);
  }

  async search(page: Page, query: SearchQuery): Promise<Page> {
    await page.goto(config.DAT_SEARCH_URL, { waitUntil: 'domcontentloaded' });

    // ── Equipment multi-select
    await page.click(DAT_SELECTORS.equipmentDropdown).catch(() => {
      logger.warn('DAT: equipment dropdown not found — selectors may be stale');
    });
    for (const eq of query.equipmentTypes) {
      const label = DAT_EQUIPMENT_MAP[eq];
      if (!label) continue;
      await page.click(`text="${label}"`, { timeout: 3000 }).catch(() => {
        logger.warn({ eq }, 'DAT: equipment option not found in dropdown');
      });
    }
    await page.keyboard.press('Escape'); // close dropdown

    // ── Origin: enter province codes one at a time
    for (const prov of query.originProvinces) {
      await this.humanType(page, DAT_SELECTORS.originInput, prov);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
    }

    // ── Date range (YYYY-MM-DD)
    const fmt = (d: Date) => d.toISOString().split('T')[0];
    await page.fill(DAT_SELECTORS.pickupDateFrom, fmt(query.pickupDateFrom));
    await page.fill(DAT_SELECTORS.pickupDateTo, fmt(query.pickupDateTo));

    // ── Submit + wait for results
    await Promise.all([
      page.waitForSelector(DAT_SELECTORS.resultsTable, { timeout: SEARCH_RESULTS_TIMEOUT_MS }),
      page.click(DAT_SELECTORS.searchSubmit),
    ]);

    // ── Wait for any spinner to disappear (best effort)
    await page
      .locator(DAT_SELECTORS.loadingSpinner)
      .waitFor({ state: 'hidden', timeout: SPINNER_TIMEOUT_MS })
      .catch(() => {
        // Spinner may not exist, or may already be gone — non-fatal.
      });

    return page;
  }

  async parseResult(page: Page): Promise<ParsedRow[]> {
    return parseDATResults(page);
  }
}
