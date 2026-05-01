/**
 * Read the loadboard_sources registry from the scraper side.
 *
 * The Vercel API path and this scraper share the same Neon DB; the
 * registry is the single source of truth for "should I poll this
 * source?". A scraper poll only runs when ingest_method='scrape'.
 *
 * Cached for 30s — the cron fires every minute, so a 30s window means
 * the worst-case lag between an operator flipping the switch and the
 * scraper noticing is ~30s. Acceptable for a cutover that happens once
 * per source ever.
 */

import type { Pool } from 'pg';
import type { LoadBoardSource } from '../adapters/base.js';
import { logger } from '../observability/logger.js';

export type IngestMethod = 'api' | 'scrape' | 'disabled' | 'cutover';

interface CacheEntry {
  method: IngestMethod;
  cachedAt: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<LoadBoardSource, CacheEntry>();

export async function getIngestMethod(
  db: Pool,
  source: LoadBoardSource,
): Promise<IngestMethod> {
  const hit = cache.get(source);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) {
    return hit.method;
  }

  try {
    const r = await db.query<{ ingest_method: IngestMethod }>(
      `SELECT ingest_method FROM loadboard_sources WHERE source = $1`,
      [source],
    );
    const method: IngestMethod = r.rows[0]?.ingest_method ?? 'disabled';
    cache.set(source, { method, cachedAt: Date.now() });
    return method;
  } catch (err) {
    // DB unavailable: fail-CLOSED for the scraper. Better to skip a poll
    // than risk double-ingest if the API path is also active.
    logger.warn(
      { err: err instanceof Error ? err.message : err, source },
      'registry lookup failed — defaulting to disabled',
    );
    return 'disabled';
  }
}

/** Force-refresh the cache for a given source (used by tests). */
export function invalidateRegistryCache(source?: LoadBoardSource): void {
  if (source) cache.delete(source);
  else cache.clear();
}
