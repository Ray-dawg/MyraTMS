import IORedis from 'ioredis';

const REDIS_URL =
  process.env.UPSTASH_REDIS_URL ||
  process.env.REDIS_URL ||
  process.env.KV_URL;

if (!REDIS_URL) {
  throw new Error(
    'BullMQ requires an ioredis-compatible Redis URL. Set UPSTASH_REDIS_URL ' +
    '(Upstash dashboard → Connect → ioredis tab). The REST URL in lib/redis.ts is NOT compatible.',
  );
}

export const redisConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  tls: REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
});

redisConnection.on('error', (err) => {
  console.error(JSON.stringify({
    level: 'error',
    message: 'redis_connection_error',
    error: err.message,
    ts: new Date().toISOString(),
  }));
});
