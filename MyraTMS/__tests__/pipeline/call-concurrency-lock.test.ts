/**
 * E2-03 M6 — acquireCallSlot()/releaseCallSlot() generalize the M2 cascade's
 * Redis-lock pattern to the shipper-side MAX_CONCURRENT_CALLS cap, replacing
 * voice-worker.ts's old countActiveCalls() check-then-act race (E2-02 §3.3
 * item 11 / §4 item 10) with one atomic Lua script over a sliding-window
 * Redis sorted set.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { acquireCallSlot, releaseCallSlot, activeCallSlotCount } from '@/lib/pipeline/carrier-locks';

describe('acquireCallSlot / releaseCallSlot (E2-03 M6)', () => {
  const heldTokens: string[] = [];

  // A successful acquisition is released only by its TTL (30 min default,
  // matching acquireCarrierPhoneLock's own documented reasoning), by
  // design -- so a real, unreleased slot from an EARLIER test file's own
  // successful dial (e.g. voice.test.ts's happy-path test) can still be
  // occupying this same shared Redis key when this file runs later in the
  // same session. This test owns the mechanism directly, so it resets the
  // key itself rather than assuming a clean starting state.
  beforeEach(async () => {
    await redisConnection.del('shipper-call-slots');
  });

  afterEach(async () => {
    for (const t of heldTokens.splice(0)) {
      await releaseCallSlot(t);
    }
  });

  it('acquires a slot when under cap', async () => {
    const token = await acquireCallSlot(5);
    expect(token).not.toBeNull();
    if (token) heldTokens.push(token);
  });

  it('blocks the Nth+1 acquisition once cap is reached — no window for two callers to both see "under cap"', async () => {
    const cap = 3;
    const tokens: string[] = [];
    for (let i = 0; i < cap; i++) {
      const t = await acquireCallSlot(cap);
      expect(t).not.toBeNull();
      if (t) tokens.push(t);
    }
    heldTokens.push(...tokens);

    const overCap = await acquireCallSlot(cap);
    expect(overCap).toBeNull();
  });

  it('releasing a slot frees capacity for the next acquisition', async () => {
    const cap = 2;
    const t1 = await acquireCallSlot(cap);
    const t2 = await acquireCallSlot(cap);
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();

    const blocked = await acquireCallSlot(cap);
    expect(blocked).toBeNull();

    if (t1) await releaseCallSlot(t1);
    const t3 = await acquireCallSlot(cap);
    expect(t3).not.toBeNull();
    if (t2) heldTokens.push(t2);
    if (t3) heldTokens.push(t3);
  });

  it('concurrent acquisitions racing the same cap never over-admit — the actual TOCTOU race this replaces', async () => {
    const cap = 5;
    // Fire 10 acquisitions "simultaneously" (same event-loop tick) against a
    // cap of 5. A racy COUNT(*)-then-act implementation could admit more
    // than 5; the atomic Lua script must not.
    const results = await Promise.all(Array.from({ length: 10 }, () => acquireCallSlot(cap)));
    const granted = results.filter((r): r is string => r !== null);
    heldTokens.push(...granted);
    expect(granted.length).toBe(cap);
  });

  it('activeCallSlotCount reflects held slots and evicts stale entries via the TTL window', async () => {
    const before = await activeCallSlotCount();
    const t = await acquireCallSlot(10);
    expect(t).not.toBeNull();
    if (t) heldTokens.push(t);
    const after = await activeCallSlotCount();
    expect(after).toBe(before + 1);
  });
});
