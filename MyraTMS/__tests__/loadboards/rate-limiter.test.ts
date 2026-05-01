/**
 * rate-limiter integration test (live Upstash REST).
 *
 * Verifies the per-minute token bucket actually rejects after the cap is
 * exhausted, then resets when the wall-clock minute rolls over.
 *
 * Uses a synthetic source name to avoid colliding with production buckets.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { redis } from '@/lib/redis';
import { takeToken, bucketUsage } from '@/lib/loadboards/rate-limiter';
import type { LoadBoardSource } from '@/lib/loadboards/base';

// Cast to the union to satisfy the type — we only use it as a string key.
const FAKE_SOURCE = '__test_fake_source__' as unknown as LoadBoardSource;

describe('rate-limiter', () => {
  beforeAll(async () => {
    // Clean up any stale bucket from a prior failed run
    const minuteEpoch = Math.floor(Date.now() / 60_000);
    await redis.del(`loadboard:rate:${FAKE_SOURCE}:${minuteEpoch}`);
  });

  afterAll(async () => {
    const minuteEpoch = Math.floor(Date.now() / 60_000);
    await redis.del(`loadboard:rate:${FAKE_SOURCE}:${minuteEpoch}`);
  });

  it('returns true under cap, false at/over cap', async () => {
    const cap = 3;
    expect(await takeToken(FAKE_SOURCE, cap)).toBe(true); // 1
    expect(await takeToken(FAKE_SOURCE, cap)).toBe(true); // 2
    expect(await takeToken(FAKE_SOURCE, cap)).toBe(true); // 3
    expect(await takeToken(FAKE_SOURCE, cap)).toBe(false); // 4 — over

    const usage = await bucketUsage(FAKE_SOURCE);
    expect(usage).toBeGreaterThanOrEqual(4);
  });

  it('returns true when cap is null/0 (no rate limit configured)', async () => {
    expect(await takeToken('dat', null)).toBe(true);
    expect(await takeToken('dat', 0)).toBe(true);
    expect(await takeToken('dat', undefined)).toBe(true);
  });
});
