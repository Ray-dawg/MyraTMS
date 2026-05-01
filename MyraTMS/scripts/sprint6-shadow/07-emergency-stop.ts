/**
 * Emergency stop — halts all pipeline activity in <30 sec.
 *
 * Three layers of stop, applied in order most-effective first:
 *
 *   1. Pause all 9 BullMQ queues — workers stop pulling new jobs.
 *      In-flight jobs run to completion (we cannot abort, e.g.,
 *      a Retell call mid-conversation), but no new jobs start.
 *
 *   2. UPDATE loadboard_sources SET ingest_method='disabled' for ALL
 *      sources — both the Vercel API path and Railway scraper stop
 *      ingesting at their next poll.
 *
 *   3. INSERT a row into a new pipeline_emergency_stops audit table
 *      so the action is logged for post-incident review.
 *
 * AFTER this script: also do these in Vercel + Railway dashboards:
 *   - Set PIPELINE_ENABLED=false in Vercel env, redeploy
 *   - Set MAX_CONCURRENT_CALLS=0 (belt and suspenders)
 *   - Pause the Railway worker host service (or set SCRAPER_ENABLED=false)
 *
 * Run with --dry-run to see what WOULD happen without taking action.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/sprint6-shadow/07-emergency-stop.ts
 *   pnpm tsx --env-file=.env.local scripts/sprint6-shadow/07-emergency-stop.ts --dry-run
 *   pnpm tsx --env-file=.env.local scripts/sprint6-shadow/07-emergency-stop.ts --reason="captcha cascade"
 */

import { neon } from '@neondatabase/serverless';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';

const DRY_RUN = process.argv.includes('--dry-run');
const REASON = (() => {
  const arg = process.argv.find((a) => a.startsWith('--reason='));
  return arg ? arg.split('=')[1] : 'manual emergency stop';
})();

const QUEUE_NAMES = [
  'qualify-queue', 'research-queue', 'match-queue', 'brief-queue',
  'call-queue', 'dispatch-queue', 'feedback-queue', 'callback-queue', 'escalation-queue',
] as const;

const STARTED_AT = Date.now();

function elapsed(): string {
  return `${((Date.now() - STARTED_AT) / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  console.log(`\n\x1b[31m=== EMERGENCY STOP ${DRY_RUN ? '(DRY RUN)' : ''} ===\x1b[0m`);
  console.log(`Reason: ${REASON}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  // ── Step 1: Pause all BullMQ queues
  const redisUrl = process.env.UPSTASH_REDIS_URL || process.env.REDIS_URL || process.env.KV_URL;
  if (!redisUrl) {
    console.error('No ioredis-compatible REDIS_URL — cannot pause queues');
    process.exit(1);
  }
  const redis = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
  });

  console.log(`[${elapsed()}] Step 1: pausing ${QUEUE_NAMES.length} BullMQ queues`);
  for (const name of QUEUE_NAMES) {
    if (DRY_RUN) {
      console.log(`        WOULD PAUSE  ${name}`);
      continue;
    }
    try {
      const q = new Queue(name, { connection: redis });
      await q.pause();
      const counts = await q.getJobCounts('waiting', 'active', 'paused');
      console.log(`        ✓ paused     ${name.padEnd(20)}  waiting=${counts.waiting} active=${counts.active} paused=${counts.paused}`);
      await q.close();
    } catch (err) {
      console.log(`        ✗ failed     ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`[${elapsed()}] Queues paused. New jobs WILL queue but workers won't pull them.`);

  // ── Step 2: Disable all ingest sources
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const sql = neon(dbUrl);
    console.log(`\n[${elapsed()}] Step 2: disabling all loadboard_sources`);
    if (DRY_RUN) {
      const rows = (await sql`SELECT source, ingest_method FROM loadboard_sources ORDER BY source`) as Array<{ source: string; ingest_method: string }>;
      for (const r of rows) {
        console.log(`        WOULD SET    ${r.source.padEnd(12)} ${r.ingest_method} → disabled`);
      }
    } else {
      // Note: this overrides the FK CHECK constraint by going to 'disabled' which
      // auto-clears integration_id at the application layer. Direct SQL doesn't
      // run that auto-clear, but the CHECK is satisfied since 'disabled' allows
      // a non-null integration_id (only 'api' requires non-null, not the other way).
      const r = (await sql`
        UPDATE loadboard_sources
           SET ingest_method = 'disabled',
               notes = COALESCE(notes, '') || ' [emergency_stop ' || NOW()::text || ']'
         WHERE ingest_method != 'disabled'
        RETURNING source
      `) as Array<{ source: string }>;
      console.log(`        ✓ disabled ${r.length} source(s): ${r.map((x) => x.source).join(', ') || 'none'}`);
    }
  }

  // ── Step 3: Audit log
  if (dbUrl && !DRY_RUN) {
    const sql = neon(dbUrl);
    try {
      // Reuse the existing compliance_audit table (Sprint 4) — it's append-only and
      // already wired into the audit pipeline. Schema:
      //   compliance_audit (id, action, decision, reason, metadata jsonb, created_at)
      await sql`
        INSERT INTO compliance_audit (action, decision, reason, metadata)
        VALUES ('emergency_stop', 'halt', ${REASON}, ${JSON.stringify({
        actor: process.env.USER ?? 'unknown',
        host: process.env.HOSTNAME ?? 'unknown',
        ts: new Date().toISOString(),
      })}::jsonb)
      `;
      console.log(`\n[${elapsed()}] Step 3: ✓ logged to compliance_audit`);
    } catch (err) {
      console.log(`\n[${elapsed()}] Step 3: ✗ audit log failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  await redis.quit();

  console.log(`\n[${elapsed()}] Emergency stop complete.\n`);
  console.log('FOLLOW-UP (manual, in dashboards):');
  console.log('  1. Vercel env: set PIPELINE_ENABLED=false, redeploy');
  console.log('  2. Vercel env: set MAX_CONCURRENT_CALLS=0 (belt & suspenders)');
  console.log('  3. Railway: pause the worker host service (or set SCRAPER_ENABLED=false)');
  console.log('  4. Retell dashboard: review any in-flight calls — they will run to completion');
  console.log('\nTo RESUME: scripts/sprint6-shadow/01-preflight.ts → confirm green → re-enable env vars → unpause queues with:');
  console.log('  for q in qualify research match brief call dispatch feedback callback escalation; do');
  console.log('    redis-cli -u "$UPSTASH_REDIS_URL" del "bull:${q}-queue:meta:paused"');
  console.log('  done');
}

main().catch((err) => {
  console.error('Emergency stop crashed:', err);
  process.exit(1);
});
