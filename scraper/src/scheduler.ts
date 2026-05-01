/**
 * Per-board polling scheduler.
 *
 * One process, multiple boards. Each board has its own interval with
 * jitter; intervals are independent. The scheduler is the only place that
 * orchestrates the full flow:
 *
 *     authenticate → search → parseResult → normalize → dedup → write → enqueue
 *
 * Hard rules:
 *   - SCRAPER_ENABLED=false halts every poll (kill switch).
 *   - In-flight detection prevents overlapping polls per board.
 *   - auth_required (mfa | captcha) halts that board only — does NOT reschedule.
 *     Other boards keep polling. Operator runs npm run dat:manual-login to recover.
 *   - Every poll writes a scraper_runs row at start and end. Failures still
 *     update the row — silent failure is forbidden.
 */

import type { Pool } from 'pg';
import type { Queue } from 'bullmq';
import type { LoadBoardAdapter, LoadBoardSource, ParsedRow, SearchQuery } from './adapters/base.js';
import type { BrowserPool } from './browser/pool.js';
import { config } from './config.js';
import { logger } from './observability/logger.js';
import { slackAlert } from './observability/slack.js';
import { recordRunStart, recordRunEnd, type RunStatus } from './observability/metrics.js';
import { isCrossSourceDuplicate } from './pipeline/dedup.js';
import { writePipelineLoad } from './pipeline/db.js';
import { buildQualifyPayload, enqueueQualify } from './pipeline/enqueue.js';
import type { RawLoad } from './pipeline/normalize.js';
import { getIngestMethod } from './pipeline/registry.js';

export interface BoardConfig {
  source: LoadBoardSource;
  enabled: boolean;
  pollIntervalMs: number;
  jitterMs: number;
  proxyUrl?: string;
  adapter: LoadBoardAdapter;
  buildQuery: () => SearchQuery;
  /** Map a ParsedRow from this adapter to a RawLoad (or null to skip). */
  normalize: (row: ParsedRow) => RawLoad | null;
}

const MIN_POLL_DELAY_MS = 60_000;
const INFLIGHT_HALT_GRACE_MS = 60_000;

export class Scheduler {
  private timers = new Map<LoadBoardSource, NodeJS.Timeout>();
  private polling = new Set<LoadBoardSource>();
  private shuttingDown = false;

  constructor(
    private pool: BrowserPool,
    private db: Pool,
    private queue: Queue,
    private boards: BoardConfig[],
  ) {}

  start(): void {
    const enabled = this.boards.filter((b) => b.enabled);
    for (const board of this.boards) {
      if (!board.enabled) {
        logger.info({ source: board.source }, 'Scheduler: board disabled, skipping');
        continue;
      }
      // Stagger initial polls so all boards don't fire at once
      const initialDelay = Math.random() * 30_000;
      setTimeout(() => this.runPoll(board), initialDelay);
    }
    logger.info({ count: enabled.length, sources: enabled.map((b) => b.source) }, 'Scheduler: started');
  }

  private scheduleNext(board: BoardConfig): void {
    if (this.shuttingDown) return;
    const jitter = (Math.random() * 2 - 1) * board.jitterMs;
    const delay = Math.max(MIN_POLL_DELAY_MS, board.pollIntervalMs + jitter);
    const t = setTimeout(() => this.runPoll(board), delay);
    this.timers.set(board.source, t);
  }

  private async runPoll(board: BoardConfig): Promise<void> {
    if (!config.SCRAPER_ENABLED) {
      logger.warn({ source: board.source }, 'Scheduler: kill switch active, skipping poll');
      this.scheduleNext(board);
      return;
    }
    if (this.polling.has(board.source)) {
      logger.warn({ source: board.source }, 'Scheduler: previous poll still running, skipping');
      this.scheduleNext(board);
      return;
    }

    // DB-backed registry check — the canonical source of truth shared
    // with the Vercel API path. The scraper only polls when this row says
    // 'scrape'. Cutover from scrape→api flips this atomically; both
    // services see the change within 30s (registry cache TTL).
    const ingestMethod = await getIngestMethod(this.db, board.source);
    if (ingestMethod !== 'scrape') {
      logger.info(
        { source: board.source, ingestMethod },
        'Scheduler: source not in scrape mode, skipping poll',
      );
      this.scheduleNext(board);
      return;
    }

    this.polling.add(board.source);
    const startedAt = Date.now();
    let runId: number | null = null;
    let status: RunStatus = 'success';
    let errorMessage: string | undefined;
    let errorStack: string | undefined;
    let loadsFound = 0;
    let loadsInserted = 0;
    let loadsDuplicates = 0;
    let loadsSkipped = 0;

    try {
      runId = await recordRunStart(this.db, board.source, config.TENANT_ID, {
        proxyUsed: board.proxyUrl,
      });

      // Step 1: authenticate (session reuse first, then login fallback)
      const ctx = await this.pool.getContext(board.source, board.proxyUrl);
      const authResult = await board.adapter.authenticate(ctx);

      if (!authResult.success) {
        if (authResult.reason === 'mfa_required' || authResult.reason === 'captcha') {
          status = 'auth_required';
          errorMessage = `${authResult.reason}: ${authResult.detail ?? ''}`.trim();
          // Don't reschedule — this board needs manual intervention.
          await this.pool.resetContext(board.source);
          throw new Error(errorMessage);
        }
        throw new Error(`Auth failed: ${authResult.reason} — ${authResult.detail}`);
      }

      // Step 2: open a fresh page for this poll, drive search, parse rows
      const page = await ctx.newPage();
      try {
        await board.adapter.search(page, board.buildQuery());
        const rows = await board.adapter.parseResult(page);
        loadsFound = rows.length;

        // Step 3: normalize → dedup → write → enqueue, one row at a time so
        // a single bad row doesn't tank the whole poll.
        for (const row of rows) {
          const load = board.normalize(row);
          if (!load) {
            loadsSkipped++;
            continue;
          }

          if (await isCrossSourceDuplicate(this.db, load)) {
            loadsDuplicates++;
            continue;
          }

          const inserted = await writePipelineLoad(this.db, load);
          if (!inserted) {
            loadsDuplicates++;
            continue;
          }

          await enqueueQualify(this.queue, buildQualifyPayload(load, inserted.id));
          loadsInserted++;
        }
      } finally {
        await page.close().catch(() => {});
      }

      // Persist session for next poll's reuse
      await this.pool.persistSession(board.source);
      // partial = some rows skipped due to validation/dedup, but the poll itself succeeded
      if (loadsSkipped > 0 && loadsInserted === 0) status = 'partial';
    } catch (err) {
      status = status === 'auth_required' ? 'auth_required' : 'failed';
      errorMessage = err instanceof Error ? err.message : String(err);
      errorStack = err instanceof Error ? err.stack : undefined;
      logger.error({ err: errorMessage, source: board.source, status }, 'Poll failed');

      await slackAlert({
        level: 'error',
        title: `Scraper poll failed: ${board.source}`,
        body: errorMessage ?? 'Unknown error',
        event: 'poll_failed',
        runId: runId ?? undefined,
        db: this.db,
        metadata: { source: board.source, status },
      });
    } finally {
      const durationMs = Date.now() - startedAt;
      if (runId !== null) {
        await recordRunEnd(this.db, runId, {
          status,
          loadsFound,
          loadsInserted,
          loadsDuplicates,
          loadsSkipped,
          errorMessage,
          errorStack,
          durationMs,
        });
      }
      logger.info(
        {
          source: board.source,
          status,
          loadsFound,
          loadsInserted,
          loadsDuplicates,
          loadsSkipped,
          durationMs,
        },
        'Poll complete',
      );
      this.polling.delete(board.source);

      // auth_required → halt that board until human intervention
      if (status !== 'auth_required') this.scheduleNext(board);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();

    // Wait for in-flight polls to finish (cap at INFLIGHT_HALT_GRACE_MS)
    const start = Date.now();
    while (this.polling.size > 0 && Date.now() - start < INFLIGHT_HALT_GRACE_MS) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (this.polling.size > 0) {
      logger.warn({ remaining: Array.from(this.polling) }, 'Scheduler: shutdown timeout, abandoning in-flight polls');
    }
  }
}
