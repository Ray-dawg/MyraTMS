/**
 * source-registry integration test (live Neon).
 *
 * Verifies the cutover semantics actually hold:
 *   - getActiveAPISources returns only ingest_method='api' rows
 *   - setIngestMethod enforces "api requires integration_id"
 *   - setIngestMethod nulls integration_id when transitioning to non-api
 *   - markPolled updates last_polled_at; isDuePoll reflects throttling
 *
 * Idempotent: leaves the loadboard_sources table in the same state it
 * found (DAT='scrape', others='disabled', nulled integrations).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import {
  getSource,
  getActiveAPISources,
  setIngestMethod,
  markPolled,
  isDuePoll,
  type SourceRow,
} from '@/lib/loadboards/source-registry';

const TEST_INTEGRATION_ID = '11111111-1111-1111-1111-111111111111';
const TEST_SOURCE = 'truckstop' as const; // safe choice — defaults to 'disabled'

describe('source-registry', () => {
  let initialState: SourceRow | null = null;

  beforeAll(async () => {
    initialState = await getSource(TEST_SOURCE);

    // Seed a synthetic integrations row to satisfy the FK during tests.
    await db.query(
      `INSERT INTO integrations (id, provider, api_key, enabled)
       VALUES ($1, 'test_truckstop', 'test_key', true)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_INTEGRATION_ID],
    );
  });

  afterAll(async () => {
    // Restore prior state — if it was 'disabled' with no integration, that's the state we leave.
    if (initialState) {
      await setIngestMethod({
        source: TEST_SOURCE,
        ingest_method: initialState.ingest_method,
        integration_id: initialState.integration_id,
      });
    }
    await db.query(`DELETE FROM integrations WHERE id = $1`, [TEST_INTEGRATION_ID]);
  });

  it('getSource returns the row or null', async () => {
    const row = await getSource(TEST_SOURCE);
    expect(row).not.toBeNull();
    expect(row?.source).toBe(TEST_SOURCE);
  });

  it('rejects ingest_method=api without integration_id', async () => {
    await expect(
      setIngestMethod({ source: TEST_SOURCE, ingest_method: 'api' as const }),
    ).rejects.toThrow(/integration_id/);
  });

  it('flips to ingest_method=api with integration_id, nulls it on flip back', async () => {
    const updated = await setIngestMethod({
      source: TEST_SOURCE,
      ingest_method: 'api',
      integration_id: TEST_INTEGRATION_ID,
    });
    expect(updated.ingest_method).toBe('api');
    expect(updated.integration_id).toBe(TEST_INTEGRATION_ID);

    // getActiveAPISources should now include it
    const active = await getActiveAPISources();
    expect(active.find((s) => s.source === TEST_SOURCE)).toBeTruthy();

    // Flip to disabled — integration_id must auto-null per source-registry semantics
    const disabled = await setIngestMethod({
      source: TEST_SOURCE,
      ingest_method: 'disabled',
    });
    expect(disabled.ingest_method).toBe('disabled');
    expect(disabled.integration_id).toBeNull();

    // No longer in the api set
    const after = await getActiveAPISources();
    expect(after.find((s) => s.source === TEST_SOURCE)).toBeFalsy();
  });

  it('markPolled + isDuePoll reflect throttling correctly', async () => {
    await markPolled(TEST_SOURCE);
    const fresh = await getSource(TEST_SOURCE);
    expect(fresh).not.toBeNull();
    // Just-polled, with default poll_interval_minutes >= 1 — should NOT be due
    expect(isDuePoll(fresh!)).toBe(false);

    // Synthetic "20 min ago" — should be due (default truckstop interval = 10 min)
    const stale: SourceRow = {
      ...fresh!,
      last_polled_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    };
    expect(isDuePoll(stale)).toBe(true);

    // Never polled (null timestamp) — always due
    const fresh2: SourceRow = { ...fresh!, last_polled_at: null };
    expect(isDuePoll(fresh2)).toBe(true);
  });
});
