/**
 * scraper_runs writers — one row per polling cycle, per source.
 *
 * Lifecycle:
 *   recordRunStart  → INSERT (status='running')           returns run_id
 *     ... poll happens ...
 *   recordRunEnd    → UPDATE (status, counts, duration)
 *
 * Granular sub-events go to scraper_log via writeLogEvent().
 */

import type { Pool } from 'pg';

export type RunStatus = 'running' | 'success' | 'partial' | 'failed' | 'auth_required';

export async function recordRunStart(
  db: Pool,
  source: string,
  tenantId: number,
  ctx?: { userAgent?: string; proxyUsed?: string; sessionReused?: boolean },
): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO scraper_runs (source, tenant_id, status, user_agent, proxy_used, session_reused)
     VALUES ($1, $2, 'running', $3, $4, $5)
     RETURNING id`,
    [source, tenantId, ctx?.userAgent ?? null, ctx?.proxyUsed ?? null, ctx?.sessionReused ?? false],
  );
  return r.rows[0].id;
}

export interface RunEnd {
  status: RunStatus;
  loadsFound: number;
  loadsInserted: number;
  loadsDuplicates: number;
  loadsSkipped: number;
  errorMessage?: string;
  errorStack?: string;
  durationMs: number;
}

export async function recordRunEnd(db: Pool, runId: number, end: RunEnd): Promise<void> {
  await db.query(
    `UPDATE scraper_runs
        SET completed_at = NOW(),
            status = $2,
            loads_found = $3,
            loads_inserted = $4,
            loads_duplicates = $5,
            loads_skipped = $6,
            error_message = $7,
            error_stack = $8,
            duration_ms = $9
      WHERE id = $1`,
    [
      runId,
      end.status,
      end.loadsFound,
      end.loadsInserted,
      end.loadsDuplicates,
      end.loadsSkipped,
      end.errorMessage ?? null,
      end.errorStack ?? null,
      end.durationMs,
    ],
  );
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Granular log writer for scraper_log. Use for events worth keeping in
 * forensics (login_attempted, captcha_detected, load_parsed, etc.) — not
 * for every console.debug.
 */
export async function writeLogEvent(
  db: Pool,
  runId: number,
  level: LogLevel,
  event: string,
  message: string | null,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO scraper_log (run_id, level, event, message, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [runId, level, event, message, metadata ? JSON.stringify(metadata) : null],
  );
}
