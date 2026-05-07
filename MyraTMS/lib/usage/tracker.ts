// =============================================================================
// Per-tenant usage tracker — Redis-backed counters for metered limits.
//
// Spec: docs/architecture/ADR-003-feature-gating.md §Usage tracking — separate concern
//
// Hot-path semantics:
//   - increment(tenantId, key, n) — INCRBY a Redis key, returns new total
//   - getCurrent(tenantId, key)   — GET the current bucket value
//   - bandFor(...)                — derive UsageBand from current vs. limit
//
// Period buckets (from LIMIT_PERIODS in lib/features/index.ts):
//   - monthly   → key suffix is YYYY-MM, TTL set to 32 days from creation
//   - daily     → key suffix is YYYY-MM-DD, TTL 36 hours
//   - concurrent → no period suffix, TTL infinite (no expiry — caller
//     must DECR when objects are released)
//
// All keys live under the namespace `tenant:{id}:usage:{key}:{period_id}`
// so a daily aggregation cron can SCAN over `tenant:*:usage:*:YYYY-MM-DD`
// and persist into the tenant_usage table (migration 031).
// =============================================================================

import { redis } from "@/lib/redis"
import { LIMIT_PERIODS, type LimitKey, type LimitPeriod } from "@/lib/features"
import { usageBand, type UsageBand, type ResolvedSubscription } from "@/lib/features/gate"

/**
 * Returns the period-id suffix for a key + a given Date. UTC-anchored so
 * it matches the daily aggregation cron's bucketing.
 */
export function periodIdFor(period: LimitPeriod, when: Date = new Date()): string {
  if (period === "monthly") {
    const yyyy = when.getUTCFullYear().toString().padStart(4, "0")
    const mm = (when.getUTCMonth() + 1).toString().padStart(2, "0")
    return `${yyyy}-${mm}`
  }
  if (period === "daily") {
    const yyyy = when.getUTCFullYear().toString().padStart(4, "0")
    const mm = (when.getUTCMonth() + 1).toString().padStart(2, "0")
    const dd = when.getUTCDate().toString().padStart(2, "0")
    return `${yyyy}-${mm}-${dd}`
  }
  // concurrent: no period component
  return "current"
}

/**
 * Returns the TTL (seconds) appropriate for a key bucket — long enough
 * for the daily aggregation cron to read, short enough that abandoned
 * counters don't accumulate forever.
 */
function ttlFor(period: LimitPeriod): number | null {
  if (period === "monthly") return 32 * 24 * 60 * 60 // 32 days
  if (period === "daily") return 36 * 60 * 60 // 36 hours
  return null // concurrent — caller manages release
}

/** Build the canonical Redis key. */
export function usageKey(
  tenantId: number,
  key: LimitKey,
  when: Date = new Date(),
): string {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(`usage/tracker: invalid tenantId ${String(tenantId)}`)
  }
  const period = LIMIT_PERIODS[key]
  const periodId = periodIdFor(period, when)
  return `tenant:${tenantId}:usage:${key}:${periodId}`
}

/**
 * Increment a metered counter. Returns the new total after increment.
 * For monthly/daily keys the first INCRBY also sets the TTL.
 *
 * Errors are swallowed and logged — usage tracking failure should NEVER
 * block the underlying operation. The trade-off: a brief Redis outage
 * leads to under-counted usage, but the user-visible call still succeeds.
 */
export async function incrementUsage(
  tenantId: number,
  key: LimitKey,
  by = 1,
): Promise<number> {
  if (by === 0) return await getCurrentUsage(tenantId, key)
  try {
    const k = usageKey(tenantId, key)
    const newValue = await redis.incrby(k, by)
    const ttl = ttlFor(LIMIT_PERIODS[key])
    if (ttl !== null) {
      // EXPIRE sets TTL idempotently — safe to call after every INCRBY,
      // though Upstash bills these as separate ops. We only call it on
      // the first increment of the bucket (when value === by).
      if (newValue === by) {
        await redis.expire(k, ttl)
      }
    }
    return Number(newValue)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[usage] increment failed (tenant=${tenantId}, key=${key}):`, err)
    return -1
  }
}

/**
 * Read the current value of a metered counter. Returns 0 if the key
 * doesn't exist (i.e., no usage in the current period yet).
 */
export async function getCurrentUsage(
  tenantId: number,
  key: LimitKey,
): Promise<number> {
  try {
    const k = usageKey(tenantId, key)
    const raw = await redis.get<number | string>(k)
    if (raw === null || raw === undefined) return 0
    return typeof raw === "number" ? raw : Number.parseInt(String(raw), 10) || 0
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[usage] read failed (tenant=${tenantId}, key=${key}):`, err)
    return 0
  }
}

/**
 * Decrement a concurrent counter — only valid for concurrent-period
 * limits (e.g., users released, personas deleted, load_boards detached).
 * No-op (and warns) for monthly/daily keys, which are forward-only.
 */
export async function decrementConcurrent(
  tenantId: number,
  key: LimitKey,
  by = 1,
): Promise<number> {
  if (LIMIT_PERIODS[key] !== "concurrent") {
    // eslint-disable-next-line no-console
    console.warn(
      `[usage] decrementConcurrent ignored for non-concurrent key '${key}' (period=${LIMIT_PERIODS[key]})`,
    )
    return await getCurrentUsage(tenantId, key)
  }
  try {
    const k = usageKey(tenantId, key)
    const newValue = await redis.decrby(k, by)
    return Math.max(0, Number(newValue))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[usage] decrement failed (tenant=${tenantId}, key=${key}):`, err)
    return -1
  }
}

/**
 * Convenience wrapper: increment a counter AND return the resulting
 * UsageBand against the tenant's effective limit. Used by route handlers
 * that want to fire a 80%/100%/150%/200% notification side-effect.
 *
 * Uses the same usageBand() classifier as withinLimit() so the bands are
 * consistent across the system.
 */
export async function incrementAndClassify(
  subscription: ResolvedSubscription,
  key: LimitKey,
  by = 1,
): Promise<{ usage: number; band: UsageBand }> {
  const usage = await incrementUsage(subscription.tenantId, key, by)
  const band = usageBand(subscription, key, usage)
  return { usage, band }
}
