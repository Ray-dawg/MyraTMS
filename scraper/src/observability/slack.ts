/**
 * Slack webhook helper.
 *
 * Hard rule from T-04A §19: "Every Slack alert ends up in scraper_log AS WELL
 * — Slack is for humans, the table is for forensics." This helper does both
 * if a `runId` is supplied, and is best-effort: a Slack delivery failure
 * never propagates to the caller.
 */

import type { Pool } from 'pg';
import { config } from '../config.js';
import { logger } from './logger.js';

const COLORS = { info: '#36a64f', warn: '#ff9900', error: '#ff0000' } as const;

export interface SlackAlertPayload {
  level: 'info' | 'warn' | 'error';
  title: string;
  body: string;
  /** Optional event tag — if set, mirrors into scraper_log under this event. */
  event?: string;
  /** Optional run_id — required for the scraper_log write. */
  runId?: number;
  /** Optional db pool — required for the scraper_log write. */
  db?: Pool;
  /** Optional structured metadata — added to the scraper_log row. */
  metadata?: Record<string, unknown>;
}

export async function slackAlert(payload: SlackAlertPayload): Promise<void> {
  // 1. Always log locally first — this is what we have if Slack is broken.
  const logFn = payload.level === 'error' ? logger.error : payload.level === 'warn' ? logger.warn : logger.info;
  logFn.call(logger, { title: payload.title, body: payload.body, ...payload.metadata }, '[slack]');

  // 2. Mirror into scraper_log if we were given a run context.
  if (payload.db && payload.runId) {
    try {
      await payload.db.query(
        `INSERT INTO scraper_log (run_id, level, event, message, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          payload.runId,
          payload.level,
          payload.event ?? 'slack_alert',
          `${payload.title} — ${payload.body}`,
          payload.metadata ? JSON.stringify(payload.metadata) : null,
        ],
      );
    } catch (e) {
      logger.warn({ err: e }, 'scraper_log insert failed (non-fatal)');
    }
  }

  // 3. Post to Slack — never propagate failure to the caller.
  if (!config.SLACK_WEBHOOK_URL) return;
  try {
    await fetch(config.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachments: [
          {
            color: COLORS[payload.level],
            title: `[Myra Scraper] ${payload.title}`,
            text: payload.body,
            ts: Math.floor(Date.now() / 1000),
          },
        ],
      }),
    });
  } catch (e) {
    logger.warn({ err: e }, 'Slack webhook failed (non-fatal)');
  }
}
