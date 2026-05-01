/**
 * DAT results parser.
 *
 * Two entry points:
 *
 *   parseDATResults(page)               — production: drives a Playwright Page,
 *                                         walks pagination, returns ParsedRow[].
 *   parseDATResultsFromDocument(doc, s) — unit-testable: pure DOM traversal of
 *                                         a single result page (no pagination).
 *                                         Test fixtures use JSDOM to drive this.
 *
 * Both share the same per-row extraction shape, so a parser regression in
 * either path shows up in the other.
 */

import type { Page } from 'playwright';
import { DAT_SELECTORS } from './selectors.js';
import type { ParsedRow } from '../base.js';
import { logger } from '../../observability/logger.js';

const MAX_PAGES = 5;
const MAX_ROWS_PER_RUN = 200;
const PAGINATION_DELAY_MS = 1500;

/** Normalized shape of a single DAT row pre-RawLoad mapping. */
export interface DATParsedFields {
  loadId: string | null;
  origin: string | null;
  destination: string | null;
  equipment: string | null;
  pickupDate: string | null;
  weight: string | null;
  length: string | null;
  rate: string | null;
  broker: string | null;
  phone: string | null;
  rowHTML: string;
}

/**
 * Pure DOM walk — given a Document and a selectors map, returns one
 * DATParsedFields per matching row. No filtering, no normalization.
 *
 * Exported so the unit test in test/parse.test.ts can drive it via JSDOM.
 */
export function parseDATResultsFromDocument(
  doc: Document,
  selectors: typeof DAT_SELECTORS,
): DATParsedFields[] {
  const rows = Array.from(doc.querySelectorAll(selectors.resultRow)) as HTMLElement[];
  return rows.map((row) => extractRow(row, selectors));
}

function extractRow(row: HTMLElement, sel: typeof DAT_SELECTORS): DATParsedFields {
  const text = (selector: string): string | null => {
    const el = row.querySelector(selector) as HTMLElement | null;
    return el?.textContent?.trim() || null;
  };
  return {
    loadId: text(sel.cellLoadId),
    origin: text(sel.cellOrigin),
    destination: text(sel.cellDestination),
    equipment: text(sel.cellEquipment),
    pickupDate: text(sel.cellPickupDate),
    weight: text(sel.cellWeight),
    length: text(sel.cellLength),
    rate: text(sel.cellRate),
    broker: text(sel.cellBroker),
    phone: text(sel.cellPhone),
    rowHTML: row.outerHTML.slice(0, 4000), // bounded for forensic re-parse
  };
}

/**
 * Production entry point. Walks pagination up to MAX_PAGES / MAX_ROWS_PER_RUN.
 *
 * Uses page.locator(...).evaluateAll() — the function body is serialized
 * and executed in the Chromium runtime, so we duplicate the row-extraction
 * logic inline (closures don't cross the serialization boundary).
 */
export async function parseDATResults(page: Page): Promise<ParsedRow[]> {
  const all: ParsedRow[] = [];
  let pagesScraped = 0;

  while (pagesScraped < MAX_PAGES && all.length < MAX_ROWS_PER_RUN) {
    pagesScraped++;

    await page.waitForSelector(DAT_SELECTORS.resultsTable, { timeout: 10_000 });

    const rowsOnPage: DATParsedFields[] = await page
      .locator(DAT_SELECTORS.resultRow)
      .evaluateAll((rows, sel) => {
        return rows.map((row) => {
          const el = row as HTMLElement;
          const text = (selector: string): string | null => {
            const node = el.querySelector(selector) as HTMLElement | null;
            return node?.textContent?.trim() || null;
          };
          return {
            loadId: text(sel.cellLoadId),
            origin: text(sel.cellOrigin),
            destination: text(sel.cellDestination),
            equipment: text(sel.cellEquipment),
            pickupDate: text(sel.cellPickupDate),
            weight: text(sel.cellWeight),
            length: text(sel.cellLength),
            rate: text(sel.cellRate),
            broker: text(sel.cellBroker),
            phone: text(sel.cellPhone),
            rowHTML: el.outerHTML.slice(0, 4000),
          };
        });
      }, DAT_SELECTORS);

    const valid = rowsOnPage.filter((r) => r.loadId && r.origin && r.destination);
    const skipped = rowsOnPage.length - valid.length;
    if (skipped > 0) {
      logger.debug({ skipped }, 'DAT: rows skipped (missing required fields)');
    }

    for (const r of valid) {
      all.push({
        ...r,
        __source: 'dat',
        __scrapedAt: new Date().toISOString(),
      } as ParsedRow);
    }

    // Pagination
    const nextBtn = page.locator(
      'button[aria-label="Next page"], a[rel="next"], button:has-text("Next")',
    );
    const hasNext = (await nextBtn.count()) > 0 && (await nextBtn.first().isEnabled());
    if (!hasNext) break;

    await nextBtn.first().click();
    await page.waitForTimeout(PAGINATION_DELAY_MS);
  }

  logger.info({ rows: all.length, pages: pagesScraped }, 'DAT: parse complete');
  return all;
}
