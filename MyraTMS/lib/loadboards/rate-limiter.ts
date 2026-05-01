/**
 * Per-source rate limiter — simple token bucket pinned to wall-clock minutes.
 *
 * Backend is Upstash REST Redis (lib/redis.ts), shared with the rest of
 * MyraTMS. Keys are prefixed `loadboard:rate:<source>:<minute-epoch>` so
 * concurrent invocations atomically increment the same counter via INCR.
 *
 * Why minute-bucket vs sliding-window: official load-board APIs publish
 * limits in "X requests per minute". Pinning to wall-clock minutes
 * matches that exactly without requiring sorted-set machinery. The 70s
 * TTL gives a 10s safety margin past the rollover.
 */

import { redis } from '@/lib/redis';
import type { LoadBoardSource } from './base';

const TTL_SECONDS = 70; // 60s window + 10s safety margin

function bucketKey(source: LoadBoardSource): string {
  const minuteEpoch = Math.floor(Date.now() / 60_000);
  return `loadboard:rate:${source}:${minuteEpoch}`;
}

/**
 * Try to consume one token from the per-minute bucket for `source`.
 *
 * Returns true if allowed (under the cap), false if rate-limited.
 *
 * If `cap` is null/undefined or non-positive, treats as "no rate limit
 * configured" and always returns true. This matches the loadboard_sources
 * column being nullable.
 */
export async function takeToken(
  source: LoadBoardSource,
  cap: number | null | undefined,
): Promise<boolean> {
  if (!cap || cap <= 0) return true;

  const key = bucketKey(source);
  try {
    const count = await redis.incr(key);
    // Set TTL only on the first increment of this bucket — INCR won't
    // refresh TTL on subsequent calls, which is what we want.
    if (count === 1) {
      await redis.expire(key, TTL_SECONDS);
    }
    return count <= cap;
  } catch (err) {
    // Redis unavailable: fail-OPEN (allow the call). Reasoning: a Redis
    // outage shouldn't halt all ingest. The board's own server-side
    // rate limit will reject us with HTTP 429 if we genuinely overshoot,
    // and our client will report rate_limited via LoadBoardAPIError.
    console.error(`[loadboard-rate-limiter] Redis error for source=${source}:`, err);
    return true;
  }
}

/**
 * Read current bucket count without consuming. Useful for ops dashboards
 * and tests. Returns 0 if no bucket yet exists for this minute.
 */
export async function bucketUsage(source: LoadBoardSource): Promise<number> {
  try {
    const v = await redis.get<number | string>(bucketKey(source));
    if (v === null || v === undefined) return 0;
    return typeof v === 'string' ? parseInt(v, 10) : v;
  } catch {
    return 0;
  }
}
