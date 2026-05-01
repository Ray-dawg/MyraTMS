/**
 * Integration test for ScannerService.pollSourceViaAPI() — drives the
 * full orchestration flow against the stub clients without hitting any
 * real load board.
 *
 * Verifies:
 *   - When ingest_method='disabled': returns 'failed' with reason and
 *     does NOT call the client (tests the gating).
 *   - When ingest_method='api' and the client is a stub: returns
 *     'not_implemented' cleanly (no crash, no insert).
 *
 * This test is the "smoke" that the cron orchestrator can run end-to-end
 * with stub clients today, and will drop in real loads when the actual
 * DAT/Truckstop clients land.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { db } from '@/lib/pipeline/db-adapter';
import { ScannerService } from '@/lib/workers/scanner-worker';
import { setIngestMethod, getSource } from '@/lib/loadboards/source-registry';
import type { SourceRow } from '@/lib/loadboards/source-registry';

const TEST_INTEGRATION_ID = '22222222-2222-2222-2222-222222222222';

describe('ScannerService.pollSourceViaAPI', () => {
  let redis: IORedis;
  let queue: Queue;
  let scanner: ScannerService;
  let initial: SourceRow | null = null;

  beforeAll(async () => {
    const url = process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL || process.env.KV_URL;
    if (!url) throw new Error('No ioredis-compatible REDIS_URL — set UPSTASH_REDIS_URL');
    redis = new IORedis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      tls: url.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    });
    queue = new Queue('qualify-queue-test-orch', { connection: redis });
    scanner = new ScannerService(redis, queue);

    initial = await getSource('123lb');

    await db.query(
      `INSERT INTO integrations (id, provider, api_key, enabled)
       VALUES ($1, 'test_truckstop_orch', 'test_key', true)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_INTEGRATION_ID],
    );
  });

  afterAll(async () => {
    if (initial) {
      await setIngestMethod({
        source: '123lb',
        ingest_method: initial.ingest_method,
        integration_id: initial.integration_id,
      });
    }
    await db.query(`DELETE FROM integrations WHERE id = $1`, [TEST_INTEGRATION_ID]);
    await queue.obliterate({ force: true });
    await queue.close();
    await redis.quit();
  });

  it('refuses to poll a source not in ingest_method=api', async () => {
    // Force into disabled state
    await setIngestMethod({ source: '123lb', ingest_method: 'disabled' });

    const result = await scanner.pollSourceViaAPI('123lb');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('disabled');
    expect(result.inserted).toBe(0);
  });

  it('returns not_implemented cleanly for a stub client in api mode', async () => {
    await setIngestMethod({
      source: '123lb',
      ingest_method: 'api',
      integration_id: TEST_INTEGRATION_ID,
    });

    const result = await scanner.pollSourceViaAPI('123lb');
    expect(result.status).toBe('not_implemented');
    expect(result.inserted).toBe(0);
    expect(result.received).toBe(0);
    // Client throws before we'd attempt any DB write — no crash, just bubble up
    expect(result.error).toBeTruthy();
  }, 30_000);
});
