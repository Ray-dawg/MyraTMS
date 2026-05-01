/**
 * myra-scraper entry point.
 *
 * Boots the long-running scraper process:
 *   1. Validate config (already done at module load by src/config.ts)
 *   2. Open Postgres pool + Redis connection + qualify-queue handle
 *   3. Launch headless Chromium via BrowserPool
 *   4. Register enabled boards
 *   5. Start the scheduler (per-board polling intervals with jitter)
 *   6. Install SIGTERM/SIGINT handlers for graceful shutdown
 *
 * Designed for Railway/Fly/Render — Vercel cannot host this (browser
 * contexts must persist across polls, which serverless can't provide).
 */

import { Pool } from 'pg';
import IORedis from 'ioredis';
import { Queue } from 'bullmq';

import { config, csvList } from './config.js';
import { logger } from './observability/logger.js';
import { slackAlert } from './observability/slack.js';
import { BrowserPool } from './browser/pool.js';
import { SessionStore } from './browser/session-store.js';
import { Scheduler, type BoardConfig } from './scheduler.js';

import { DATAdapter } from './adapters/dat/index.js';
import { TruckstopAdapter } from './adapters/truckstop/index.js';
import { LoadBoard123Adapter } from './adapters/loadboard123/index.js';
import { LoadlinkAdapter } from './adapters/loadlink/index.js';

import { normalizeDATRow } from './pipeline/normalize.js';
import type { SearchQuery } from './adapters/base.js';

async function main(): Promise<void> {
  logger.info({ env: config.NODE_ENV, killSwitch: config.SCRAPER_ENABLED }, 'myra-scraper booting');

  // ── Postgres
  const db = new Pool({
    connectionString: config.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
  });

  // ── Redis (BullMQ + session store both use this connection)
  const redis = new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null, // BullMQ requirement
    enableReadyCheck: false,
  });
  redis.on('error', (err) => logger.error({ err: err.message }, 'redis error'));

  // ── BullMQ qualify-queue (write-only from the scraper's POV)
  const qualifyQueue = new Queue(config.QUALIFY_QUEUE_NAME, { connection: redis });

  // ── Session store + browser pool
  const sessionStore = new SessionStore(redis);
  const browserPool = new BrowserPool(sessionStore);
  await browserPool.init();

  // ── Build per-board configs
  const equipmentTypes = csvList(config.DAT_EQUIPMENT) as SearchQuery['equipmentTypes'];
  const originProvinces = csvList(config.DAT_ORIGIN_PROVINCES);

  const buildDATQuery = (): SearchQuery => {
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + config.DAT_DAYS_FORWARD);
    return {
      equipmentTypes,
      originProvinces,
      pickupDateFrom: now,
      pickupDateTo: end,
    };
  };

  const boards: BoardConfig[] = [
    {
      source: 'dat',
      enabled: config.DAT_ENABLED,
      pollIntervalMs: config.DAT_POLL_INTERVAL_MS,
      jitterMs: config.DAT_POLL_JITTER_MS,
      proxyUrl: config.DAT_PROXY_URL,
      adapter: new DATAdapter(),
      buildQuery: buildDATQuery,
      normalize: normalizeDATRow,
    },
    {
      source: 'truckstop',
      enabled: config.TRUCKSTOP_ENABLED,
      pollIntervalMs: 600_000,
      jitterMs: 60_000,
      adapter: new TruckstopAdapter(),
      buildQuery: buildDATQuery, // placeholder until real query builder lands
      normalize: () => null,
    },
    {
      source: '123lb',
      enabled: config.LOADBOARD123_ENABLED,
      pollIntervalMs: 600_000,
      jitterMs: 60_000,
      adapter: new LoadBoard123Adapter(),
      buildQuery: buildDATQuery,
      normalize: () => null,
    },
    {
      source: 'loadlink',
      enabled: config.LOADLINK_ENABLED,
      pollIntervalMs: 600_000,
      jitterMs: 60_000,
      adapter: new LoadlinkAdapter(),
      buildQuery: buildDATQuery,
      normalize: () => null,
    },
  ];

  // ── Scheduler
  const scheduler = new Scheduler(browserPool, db, qualifyQueue, boards);
  scheduler.start();

  await slackAlert({
    level: 'info',
    title: 'Scraper started',
    body: `Boards enabled: ${boards.filter((b) => b.enabled).map((b) => b.source).join(', ') || 'none'}`,
  });

  // ── Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'myra-scraper shutting down');
    try {
      await scheduler.shutdown();
      await browserPool.shutdown();
      await qualifyQueue.close();
      await redis.quit();
      await db.end();
    } catch (e) {
      logger.error({ err: e instanceof Error ? e.message : e }, 'shutdown error (non-fatal)');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info('myra-scraper running — awaiting first poll');
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err, stack: err?.stack }, 'fatal boot error');
  process.exit(1);
});
