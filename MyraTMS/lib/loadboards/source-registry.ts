/**
 * Source registry — read/write helpers over the loadboard_sources table.
 *
 * This is the single source of truth shared between:
 *   - MyraTMS Vercel cron (this file's caller)
 *   - Railway scraper (reads same table; lives in M1/scraper/)
 *
 * Flipping a row here is the cutover. No deploys required.
 */

import { db } from '@/lib/pipeline/db-adapter';
import type { LoadBoardSource } from './base';

export type IngestMethod = 'api' | 'scrape' | 'disabled' | 'cutover';

export interface SourceRow {
  source: LoadBoardSource;
  ingest_method: IngestMethod;
  /** UUID of the integrations row holding API creds; null unless ingest_method='api'. */
  integration_id: string | null;
  poll_interval_minutes: number;
  rate_limit_per_minute: number | null;
  last_polled_at: string | null;
  notes: string | null;
  updated_at: string;
}

const VALID_METHODS: IngestMethod[] = ['api', 'scrape', 'disabled', 'cutover'];
const VALID_SOURCES: LoadBoardSource[] = ['dat', 'truckstop', '123lb', 'loadlink'];

/**
 * Read one source's full state. Returns null if no row exists for that
 * source (shouldn't happen post-migration; defensive).
 */
export async function getSource(source: LoadBoardSource): Promise<SourceRow | null> {
  const r = await db.query<SourceRow>(
    `SELECT source, ingest_method, integration_id, poll_interval_minutes,
            rate_limit_per_minute, last_polled_at::text, notes, updated_at::text
       FROM loadboard_sources
      WHERE source = $1`,
    [source],
  );
  return r.rows[0] ?? null;
}

/**
 * All sources currently in 'api' mode — i.e. the ones the Vercel cron
 * should poll. Only this set is iterated by /api/cron/pipeline-scan.
 */
export async function getActiveAPISources(): Promise<SourceRow[]> {
  const r = await db.query<SourceRow>(
    `SELECT source, ingest_method, integration_id, poll_interval_minutes,
            rate_limit_per_minute, last_polled_at::text, notes, updated_at::text
       FROM loadboard_sources
      WHERE ingest_method = 'api'
      ORDER BY source`,
  );
  return r.rows;
}

/**
 * Update last_polled_at to NOW(). Called by the cron after a successful
 * (or failed) poll dispatch — the timestamp is used for throttling, not
 * outcome tracking. Failures still bump the timestamp so we don't hammer
 * a broken board.
 */
export async function markPolled(source: LoadBoardSource): Promise<void> {
  await db.query(
    `UPDATE loadboard_sources SET last_polled_at = NOW() WHERE source = $1`,
    [source],
  );
}

/**
 * True if enough time has elapsed since last_polled_at for this source's
 * configured poll_interval_minutes. Used by the cron to throttle (cron
 * fires every 1 min; per-source intervals can be 5/10/15+ min).
 */
export function isDuePoll(row: SourceRow): boolean {
  if (!row.last_polled_at) return true;
  const elapsedMs = Date.now() - new Date(row.last_polled_at).getTime();
  return elapsedMs >= row.poll_interval_minutes * 60_000;
}

export interface SetIngestMethodInput {
  source: LoadBoardSource;
  ingest_method: IngestMethod;
  /** Required when ingest_method='api'; ignored otherwise. */
  integration_id?: string | null;
  notes?: string;
}

/**
 * Flip a source's ingest method. Validates the transition and sets
 * integration_id correctly per the CHECK constraint:
 *
 *   ingest_method = 'api'      → integration_id REQUIRED
 *   ingest_method != 'api'     → integration_id forcibly NULLed
 *
 * Throws if the input violates these rules. Does NOT validate that the
 * referenced integration row exists — the FK enforces that at insert.
 */
export async function setIngestMethod(input: SetIngestMethodInput): Promise<SourceRow> {
  if (!VALID_SOURCES.includes(input.source)) {
    throw new Error(`Invalid source: ${input.source}`);
  }
  if (!VALID_METHODS.includes(input.ingest_method)) {
    throw new Error(`Invalid ingest_method: ${input.ingest_method}`);
  }
  if (input.ingest_method === 'api' && !input.integration_id) {
    throw new Error(`ingest_method='api' requires integration_id`);
  }

  // Force integration_id to null for non-api states (cleaner than relying
  // on the caller to know).
  const integrationId = input.ingest_method === 'api' ? input.integration_id! : null;

  const r = await db.query<SourceRow>(
    `UPDATE loadboard_sources
        SET ingest_method = $2,
            integration_id = $3,
            notes = COALESCE($4, notes)
      WHERE source = $1
      RETURNING source, ingest_method, integration_id, poll_interval_minutes,
                rate_limit_per_minute, last_polled_at::text, notes, updated_at::text`,
    [input.source, input.ingest_method, integrationId, input.notes ?? null],
  );

  if (r.rows.length === 0) {
    throw new Error(`No row exists for source=${input.source} (migration 026 not applied?)`);
  }
  return r.rows[0];
}
