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
