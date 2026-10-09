import { NextResponse } from "next/server"
import { getDb } from "@/lib/db"
import { redis } from "@/lib/redis"

/**
 * GET /api/health — liveness + dependency probe.
 *
 * Pings Postgres (Neon) and Redis (Upstash REST) with a 3s timeout each.
 * Returns 200 when both are reachable, 503 if either fails. Latencies are
 * always reported for observability; uptime monitors (Railway, Vercel,
 * external) should treat 503 as a failed health check.
 *
 * The Engine 2 BullMQ ioredis connection (lib/pipeline/redis-bullmq.ts) is
 * intentionally NOT probed here — opening a TCP socket on every health
 * request is wasteful on Vercel's serverless functions and the REST PING
 * is sufficient signal that Upstash is reachable.
 *
 * Public: no auth (bypassed in middleware.ts SELF_AUTHENTICATING_PATHS). Safe
 * to expose because it returns only generic latencies and a constant failure
 * marker -- no DB rows, no secrets, and no driver error strings (those carry
 * the Neon/Upstash hostname; see OPAQUE_ERROR below).
 */

const CHECK_TIMEOUT_MS = 3000

interface CheckResult {
  ok: boolean
  latency_ms: number
  error?: string
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

// This route is unauthenticated (see middleware.ts SELF_AUTHENTICATING_PATHS),
// so the response body must never carry a driver error string. Neon/Upstash
// connection faults put the hostname in `e.message` -- e.g. "getaddrinfo
// ENOTFOUND ep-<endpoint-id>.<region>.aws.neon.tech" -- which would publish
// the production endpoint id in a 503 body to any anonymous caller. Log the
// real message server-side; return a constant.
const OPAQUE_ERROR = "unreachable"

function logProbeFailure(dependency: string, e: unknown): void {
  console.error(
    `[health] ${dependency} probe failed:`,
    e instanceof Error ? e.message : String(e),
  )
}

async function checkDb(): Promise<CheckResult> {
  const t0 = Date.now()
  try {
    const sql = getDb()
    await withTimeout(sql`SELECT 1 AS ok`, CHECK_TIMEOUT_MS)
    return { ok: true, latency_ms: Date.now() - t0 }
  } catch (e) {
    logProbeFailure("db", e)
    return { ok: false, latency_ms: Date.now() - t0, error: OPAQUE_ERROR }
  }
}

async function checkRedis(): Promise<CheckResult> {
  const t0 = Date.now()
  try {
    await withTimeout(redis.ping(), CHECK_TIMEOUT_MS)
    return { ok: true, latency_ms: Date.now() - t0 }
  } catch (e) {
    logProbeFailure("redis", e)
    return { ok: false, latency_ms: Date.now() - t0, error: OPAQUE_ERROR }
  }
}

export async function GET() {
  const [db, redisResult] = await Promise.all([checkDb(), checkRedis()])
  const allOk = db.ok && redisResult.ok
  return NextResponse.json(
    {
      status: allOk ? "ok" : "degraded",
      ts: new Date().toISOString(),
      checks: { db, redis: redisResult },
    },
    { status: allOk ? 200 : 503 },
  )
}
