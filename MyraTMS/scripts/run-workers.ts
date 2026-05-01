/**
 * Worker host entry-point.
 *
 * Boots all Engine 2 BullMQ workers in a single process. Used for:
 *   - Local development:  `pnpm tsx --env-file=.env.local scripts/run-workers.ts`
 *   - Production worker:  Railway / Fly.io / Render long-running container
 *
 * Vercel cannot host these workers — they're persistent processes that own
 * BullMQ connections. The Next.js app in MyraTMS still runs on Vercel for
 * the API routes; this script runs alongside on a worker host.
 *
 * Wires every queue to its corresponding worker, sharing one ioredis
 * connection (Upstash). Handles SIGTERM / SIGINT for graceful shutdown so
 * in-flight jobs can finish before the host kills the process.
 *
 * Kill switches honored:
 *   PIPELINE_ENABLED=false   → all workers stay paused (no jobs processed)
 *   SCANNER_ENABLED=false    → scanner cron heartbeat stays a noop
 *   MAX_CONCURRENT_CALLS=0   → Voice worker enters shadow mode (per worker)
 */

import { Queue } from 'bullmq';
import { redisConnection } from '../lib/pipeline/redis-bullmq';
import { logger } from '../lib/logger';
import { QualifierWorker } from '../lib/workers/qualifier-worker';
import { ResearcherWorker } from '../lib/workers/researcher-worker';
import { RankerWorker } from '../lib/workers/ranker-worker';
import { CompilerWorker } from '../lib/workers/compiler-worker';
import { VoiceWorker } from '../lib/workers/voice-worker';
import { DispatcherWorker } from '../lib/workers/dispatcher-worker';
import { FeedbackWorker } from '../lib/workers/feedback-worker';

interface WorkerEntry {
  name: string;
  shutdown: () => Promise<void>;
}

async function main() {
  logger.info('[worker-host] Starting Engine 2 worker pool');

  // Outbound queues — each worker that fans out to a downstream queue holds
  // a Queue instance. Sharing one ioredis connection across all of them is
  // safe and recommended by BullMQ.
  const researchQ = new Queue('research-queue', { connection: redisConnection });
  const matchQ = new Queue('match-queue', { connection: redisConnection });
  const briefQ = new Queue('brief-queue', { connection: redisConnection });
  const callQ = new Queue('call-queue', { connection: redisConnection });

  // Construct workers. Each one starts listening on its queue immediately;
  // PIPELINE_ENABLED gating happens inside the workers' process() methods,
  // not here, so jobs can still be enqueued and the kill switch flip can be
  // observed without restarting the host.
  const workers: WorkerEntry[] = [];

  const qualifier = new QualifierWorker(redisConnection, researchQ, matchQ);
  workers.push({ name: 'qualifier', shutdown: () => qualifier.shutdown() });

  const researcher = new ResearcherWorker(redisConnection, briefQ);
  workers.push({ name: 'researcher', shutdown: () => researcher.shutdown() });

  const ranker = new RankerWorker(redisConnection, briefQ);
  workers.push({ name: 'ranker', shutdown: () => ranker.shutdown() });

  const compiler = new CompilerWorker(redisConnection, callQ);
  workers.push({ name: 'compiler', shutdown: () => compiler.shutdown() });

  const voice = new VoiceWorker(redisConnection);
  workers.push({ name: 'voice', shutdown: () => voice.shutdown() });

  const dispatcher = new DispatcherWorker(redisConnection);
  workers.push({ name: 'dispatcher', shutdown: () => dispatcher.shutdown() });

  const feedback = new FeedbackWorker(redisConnection);
  workers.push({ name: 'feedback', shutdown: () => feedback.shutdown() });

  logger.info(`[worker-host] ${workers.length} workers running: ${workers.map((w) => w.name).join(', ')}`);
  logger.info('[worker-host] Kill switches: ' + JSON.stringify({
    PIPELINE_ENABLED: process.env.PIPELINE_ENABLED ?? 'false',
    SCANNER_ENABLED: process.env.SCANNER_ENABLED ?? 'false',
    MAX_CONCURRENT_CALLS: process.env.MAX_CONCURRENT_CALLS ?? '1',
    AUTO_BOOK_PROFIT_THRESHOLD: process.env.AUTO_BOOK_PROFIT_THRESHOLD ?? '999999',
  }));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[worker-host] ${signal} received, shutting down workers gracefully`);
    try {
      await Promise.all(workers.map((w) => w.shutdown().catch((err) => {
        logger.error(`[worker-host] error shutting down ${w.name}`, err);
      })));
      await Promise.all([
        researchQ.close(),
        matchQ.close(),
        briefQ.close(),
        callQ.close(),
      ]);
      logger.info('[worker-host] Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('[worker-host] Shutdown error', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.error('[worker-host] uncaughtException', err);
    shutdown('uncaughtException').catch(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('[worker-host] unhandledRejection', reason);
  });

  // Heartbeat — useful when running under PM2 / Railway to confirm liveness.
  const heartbeatMs = Number(process.env.WORKER_HEARTBEAT_MS ?? '60000');
  setInterval(() => {
    logger.debug('[worker-host] heartbeat', { workers: workers.length });
  }, heartbeatMs);
}

main().catch((err) => {
  logger.error('[worker-host] startup failure', err);
  process.exit(1);
});
