import { randomUUID } from 'crypto';
import { redisConnection } from './redis-bullmq';

const RELEASE_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

const DEFAULT_LOAD_LOCK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PHONE_LOCK_TTL_MS = 5 * 60 * 1000;

function loadLockKey(pipelineLoadId: number): string {
  return `carrier-lock:load:${pipelineLoadId}`;
}

function phoneLockKey(phoneE164: string): string {
  return `carrier-lock:phone:${phoneE164}`;
}

async function acquire(key: string, ttlMs: number): Promise<string | null> {
  const token = randomUUID();
  const result = await redisConnection.set(key, token, 'PX', ttlMs, 'NX');
  return result === 'OK' ? token : null;
}

async function release(key: string, token: string): Promise<void> {
  await redisConnection.eval(RELEASE_IF_OWNER_SCRIPT, 1, key, token);
}

export async function acquireLoadLock(
  pipelineLoadId: number,
  ttlMs: number = DEFAULT_LOAD_LOCK_TTL_MS,
): Promise<string | null> {
  return acquire(loadLockKey(pipelineLoadId), ttlMs);
}

export async function releaseLoadLock(pipelineLoadId: number, token: string): Promise<void> {
  await release(loadLockKey(pipelineLoadId), token);
}

export async function acquireCarrierPhoneLock(
  phoneE164: string,
  ttlMs: number = DEFAULT_PHONE_LOCK_TTL_MS,
): Promise<string | null> {
  return acquire(phoneLockKey(phoneE164), ttlMs);
}

export async function releaseCarrierPhoneLock(phoneE164: string, token: string): Promise<void> {
  await release(phoneLockKey(phoneE164), token);
}

// ─────────────────────────────────────────────────────────────────────────
// E2-03 M6 — generalizes the lock pattern above to the shipper-side
// MAX_CONCURRENT_CALLS cap (E2-02 §3.3 item 11 / §4 item 10: "a global
// count with no actual lock — a latent race today"). voice-worker.ts's
// countActiveCalls() is a plain `SELECT COUNT(*) WHERE stage='calling'`:
// two workers can both read count < max in the same instant and both
// proceed, pushing active calls past the cap — a classic check-then-act
// race, not fixable by a single boolean lock (acquire/release above) since
// the resource being guarded is a COUNT, not a single slot.
//
// Implemented as a sliding-window semaphore over a Redis sorted set: each
// acquisition is a ZADD member scored by acquire time; acquiring first
// evicts members older than ttlMs (stale/never-released slots), then
// checks ZCARD < max, atomically, in one Lua script. TTL-based expiry is
// the release mechanism for a successful dial (mirrors
// acquireCarrierPhoneLock's own documented reasoning: the call's real
// duration is unknown to this process and the eventual webhook that learns
// the outcome runs in a separate request/process without this token) — a
// FAILED dial attempt releases its slot immediately instead of holding it
// uselessly for the full TTL, via releaseCallSlot() in the caller's catch.
// ─────────────────────────────────────────────────────────────────────────

const CALL_SLOTS_KEY = 'shipper-call-slots';
const DEFAULT_CALL_SLOT_TTL_MS = 30 * 60 * 1000; // 30 min — generous upper bound on a real call's duration

const ACQUIRE_SLOT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local token = ARGV[4]
redis.call("ZREMRANGEBYSCORE", key, "-inf", now - ttl)
local count = redis.call("ZCARD", key)
if count < max then
  redis.call("ZADD", key, now, token)
  redis.call("PEXPIRE", key, ttl)
  return 1
else
  return 0
end
`;

/**
 * Atomically checks the active-call count against `maxConcurrent` and
 * reserves a slot if under cap, in one round trip — no window between
 * "check" and "act" for a second worker to race through.
 */
export async function acquireCallSlot(
  maxConcurrent: number,
  ttlMs: number = DEFAULT_CALL_SLOT_TTL_MS,
): Promise<string | null> {
  const token = randomUUID();
  const result = await redisConnection.eval(
    ACQUIRE_SLOT_SCRIPT,
    1,
    CALL_SLOTS_KEY,
    String(Date.now()),
    String(ttlMs),
    String(maxConcurrent),
    token,
  );
  return result === 1 ? token : null;
}

export async function releaseCallSlot(token: string): Promise<void> {
  await redisConnection.zrem(CALL_SLOTS_KEY, token);
}

/** Current occupied-slot count, evicting stale entries first. Observability only. */
export async function activeCallSlotCount(ttlMs: number = DEFAULT_CALL_SLOT_TTL_MS): Promise<number> {
  const now = Date.now();
  await redisConnection.zremrangebyscore(CALL_SLOTS_KEY, '-inf', now - ttlMs);
  return redisConnection.zcard(CALL_SLOTS_KEY);
}
