/**
 * Sprint 1B smoke test: confirms BullMQ → Upstash Redis connectivity.
 * Adds and removes a probe job on qualify-queue to exercise the full path.
 *
 * Usage: pnpm tsx --env-file=.env.local scripts/test-queue-connection.ts
 *
 * Exit 0 = OK, exit 1 = fail (with diagnostic).
 */

import { Queue } from 'bullmq';
import { redisConnection } from '@/lib/pipeline/redis-bullmq';
import { QUALIFY_QUEUE_CONFIG } from '@/lib/pipeline/queues';

async function main() {
  // 1. Raw PING — confirms TCP/TLS handshake works
  const pong = await redisConnection.ping();
  if (pong !== 'PONG') throw new Error(`Unexpected PING response: ${pong}`);
  console.log('[1/3] Redis PING → PONG ✓');

  // 2. Construct a Queue against the same connection
  const q = new Queue(QUALIFY_QUEUE_CONFIG.queueName, { connection: redisConnection });
  console.log(`[2/3] Queue '${QUALIFY_QUEUE_CONFIG.queueName}' constructed ✓`);

  // 3. Round-trip a probe job (add + delete, never processed)
  const job = await q.add('probe', { probe: true, sentAt: new Date().toISOString() }, {
    removeOnComplete: true,
    removeOnFail: true,
  });
  if (!job.id) throw new Error('Job add returned no id');
  await job.remove();
  console.log(`[3/3] Probe job ${job.id} added and removed ✓`);

  await q.close();
  await redisConnection.quit();
  console.log('\n=== Queue connection: OK ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n=== Queue connection: FAIL ===');
  console.error(err?.message || err);
  if (err?.code) console.error(`code: ${err.code}`);
  process.exit(1);
});
