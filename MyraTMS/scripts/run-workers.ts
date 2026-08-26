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
 *   PIPELINE_ENABLED=false     → all workers stay paused (no jobs processed)
 *   SCANNER_ENABLED=false      → scanner cron heartbeat stays a noop
 *   MAX_CONCURRENT_CALLS=0     → Voice worker enters shadow mode (per worker)
 *   CARRIER_CALLS_ENABLED      → CarrierVoiceWorker's own shadow-mode gate
 *                                (E2-03 M2/M6, still defaults false)
 *
 * E2-04: this host now also boots ShipperConfirmationWorker,
 * CarrierBriefCompilerWorker, and CarrierVoiceWorker -- previously the
 * carrier-call-queue consumer (CarrierVoiceWorker) had existed in
 * lib/workers/ since E2-03 M2 without this file ever constructing it, and
 * nothing anywhere enqueued that queue's first job until E2-04 M5's
 * CarrierBriefCompilerWorker. Both gaps are closed here.
 */

import { Queue } from 'bullmq';
import { redisConnection } from '../lib/pipeline/redis-bullmq';
import { neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { logger } from '../lib/logger';
import { QualifierWorker } from '../lib/workers/qualifier-worker';

// The Neon serverless Pool used by lib/db/tenant-context.ts (tenant-scoped
// transactions via SET LOCAL) requires an explicit WebSocket constructor when
// running under Node. Vercel's serverless runtime supplies one; this Railway
// worker host does not. Without it, every withTenant() call fails with
// "All attempts to open a WebSocket to connect to the database failed" — which
// takes down the Ranker (matchCarriers runs inside withTenant) and stalls the
// parallel gate. Set it once here, before any worker processes a job.
neonConfig.webSocketConstructor = ws;
import { ResearcherWorker } from '../lib/workers/researcher-worker';
import { RankerWorker } from '../lib/workers/ranker-worker';
import { CompilerWorker } from '../lib/workers/compiler-worker';
import { VoiceWorker } from '../lib/workers/voice-worker';
import { DispatcherWorker } from '../lib/workers/dispatcher-worker';
import { FeedbackWorker } from '../lib/workers/feedback-worker';
// E2-04 M2/M5, E2-03 M2 — previously never booted here. carrier-call-queue
// has had a real consumer (CarrierVoiceWorker) sitting in lib/workers/ since
// E2-03 M2, and a real producer (CarrierBriefCompilerWorker) since E2-04 M5,
// but this host never constructed either one — confirmed via this session's
// own architecture audit, the exact gap the E2-04 PRD exists to close.
import { ShipperConfirmationWorker } from '../lib/workers/shipper-confirmation-worker';
import { CarrierBriefCompilerWorker } from '../lib/workers/carrier-brief-compiler-worker';
import { CarrierVoiceWorker } from '../lib/workers/carrier-voice-worker';

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
  // E2-04: ShipperConfirmationWorker re-enqueues its own queue for the
  // nudge/escalate self-schedule; CarrierBriefCompilerWorker's whole reason
  // for existing is the enqueue onto carrierCallQ below.
  const shipperConfirmationQ = new Queue('shipper-confirmation-queue', { connection: redisConnection });
  const carrierCallQ = new Queue('carrier-call-queue', { connection: redisConnection });

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

  const shipperConfirmation = new ShipperConfirmationWorker(redisConnection, shipperConfirmationQ);
  workers.push({ name: 'shipper-confirmation', shutdown: () => shipperConfirmation.shutdown() });

  const carrierBriefCompiler = new CarrierBriefCompilerWorker(redisConnection, carrierCallQ);
  workers.push({ name: 'carrier-brief-compiler', shutdown: () => carrierBriefCompiler.shutdown() });

  const carrierVoice = new CarrierVoiceWorker(redisConnection);
  workers.push({ name: 'carrier-voice', shutdown: () => carrierVoice.shutdown() });

  logger.info(`[worker-host] ${workers.length} workers running: ${workers.map((w) => w.name).join(', ')}`);
  logger.info('[worker-host] Kill switches: ' + JSON.stringify({
    PIPELINE_ENABLED: process.env.PIPELINE_ENABLED ?? 'false',
    SCANNER_ENABLED: process.env.SCANNER_ENABLED ?? 'false',
    MAX_CONCURRENT_CALLS: process.env.MAX_CONCURRENT_CALLS ?? '1',
    // AUTO_BOOK_PROFIT_THRESHOLD retired (T-18/T-19) — never read by any
    // decision path. The real margin-floor mechanism is
    // lib/tenants/margin-floor.ts getMarginFloor(), backed by T-18's
    // authority_envelopes. Kept here only as a startup-log breadcrumb in
    // case an old .env still sets it, so an operator sees it's inert.
    AUTO_BOOK_PROFIT_THRESHOLD: `${process.env.AUTO_BOOK_PROFIT_THRESHOLD ?? '(unset)'} (inert — see getMarginFloor())`,
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
        shipperConfirmationQ.close(),
        carrierCallQ.close(),
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
