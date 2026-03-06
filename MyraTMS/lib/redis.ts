import { Redis } from "@upstash/redis"

export const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
})

/**
 * Get a cached value by key. Returns null if not found or on error.
 */
export async function getCached<T>(key: string): Promise<T | null> {
  try {
    const value = await redis.get<T>(key)
    return value ?? null
  } catch (err) {
    console.error(`[Redis] getCached error for key "${key}":`, err)
    return null
  }
}

/**
 * Set a cache value with a TTL in seconds.
 */
export async function setCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(key, value, { ex: ttlSeconds })
  } catch (err) {
    console.error(`[Redis] setCache error for key "${key}":`, err)
  }
}

/**
 * Invalidate cache entries matching a pattern.
 * Uses SCAN to find matching keys and DEL to remove them.
 * Pattern supports glob-style: e.g., "loadboard:*" or "gps:*"
 */
export async function invalidateCache(pattern: string): Promise<void> {
  try {
    let cursor = 0
    do {
      const result = await redis.scan(cursor, { match: pattern, count: 100 }) as unknown as [number, string[]]
      cursor = result[0]
      const keys = result[1]
      if (keys.length > 0) {
        const pipeline = redis.pipeline()
        for (const key of keys) {
          pipeline.del(key)
        }
        await pipeline.exec()
      }
    } while (cursor !== 0)
  } catch (err) {
    console.error(`[Redis] invalidateCache error for pattern "${pattern}":`, err)
  }
}
