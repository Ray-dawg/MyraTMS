/**
 * T-17 backfill: reconstructs `events` rows for everything that happened
 * before the migration 033 triggers existed. Idempotent (relies on the same
 * ON CONFLICT DO NOTHING that fn_insert_event uses) — safe to re-run or
 * interrupt. Batches by primary-key range, 5,000 rows/batch, per T-17 §5.3.
 *
 * Known limitation: pipeline_loads only stores the CURRENT stage, not stage
 * history, so backfill can only emit one load.stage_changed / typed-stage
 * event per load (stage_from = NULL, stage_to = current stage). Every stage
 * transition from this point forward is captured in full by the triggers.
 *
 * Usage: DATABASE_URL=<branch or prod URL> pnpm tsx scripts/t17_backfill_events.ts
 */

import { db } from '../lib/pipeline/db-adapter';

const BATCH_SIZE = 5000;

interface BackfillStep {
  table: string;
  sql: string;
}

async function maxId(table: string): Promise<number> {
  const r = await db.query<{ max: number | null }>(`SELECT MAX(id) AS max FROM ${table}`);
  return r.rows[0]?.max ?? 0;
}

async function runBatched(table: string, sql: string): Promise<void> {
  const highWaterMark = await maxId(table);
  let cursor = 0;
  while (cursor < highWaterMark) {
    const upper = Math.min(cursor + BATCH_SIZE, highWaterMark);
    await db.query(sql, [cursor, upper]);
    console.log(`[t17-backfill] ${table}: processed id (${cursor}, ${upper}]`);
    cursor = upper;
  }
}

const PIPELINE_LOADS_STEPS: BackfillStep[] = [
  {
    table: 'pipeline_loads',
    sql: `SELECT fn_insert_event(
            1, 'load.scanned', 'load', id, id, 'system', 'system',
            jsonb_build_object('load_id', load_id, 'source', load_board_source),
            NULL, NULL, created_at, 'pipeline_loads', id, 'load-' || id
          ) FROM pipeline_loads WHERE id > $1 AND id <= $2`,
  },
  {
    table: 'pipeline_loads',
    sql: `SELECT fn_insert_event(
            1, 'load.stage_changed', 'load', id, id, 'system', 'system',
            jsonb_build_object('load_id', load_id, 'source', load_board_source),
            NULL, stage, COALESCE(stage_updated_at, created_at), 'pipeline_loads', id, 'load-' || id
          ) FROM pipeline_loads WHERE id > $1 AND id <= $2`,
  },
  {
    table: 'pipeline_loads',
    sql: `SELECT fn_insert_event(
            1, fn_stage_event_type(stage), 'load', id, id, 'system', 'system',
            jsonb_build_object('load_id', load_id, 'source', load_board_source),
            NULL, stage, COALESCE(stage_updated_at, created_at), 'pipeline_loads', id, 'load-' || id
          ) FROM pipeline_loads WHERE fn_stage_event_type(stage) IS NOT NULL AND id > $1 AND id <= $2`,
  },
  {
    table: 'pipeline_loads',
    sql: `SELECT fn_insert_event(
            1, 'load.researched', 'load', id, id, 'researcher', 'agent',
            jsonb_build_object('market_rate_mid', market_rate_mid, 'recommended_strategy', recommended_strategy),
            NULL, NULL, research_completed_at, 'pipeline_loads', id, 'load-' || id
          ) FROM pipeline_loads WHERE research_completed_at IS NOT NULL AND id > $1 AND id <= $2`,
  },
];

const AGENT_CALLS_STEPS: BackfillStep[] = [
  {
    table: 'agent_calls',
    sql: `SELECT fn_insert_event(
            1, 'call.initiated', 'call', id, pipeline_load_id, 'voice', 'agent',
            jsonb_build_object('call_id', call_id, 'persona', persona, 'call_type', call_type),
            NULL, NULL, call_initiated_at, 'agent_calls', id,
            CASE WHEN pipeline_load_id IS NOT NULL THEN 'load-' || pipeline_load_id ELSE NULL END
          ) FROM agent_calls WHERE id > $1 AND id <= $2`,
  },
  {
    table: 'agent_calls',
    sql: `SELECT fn_insert_event(
            1, 'call.connected', 'call', id, pipeline_load_id, 'voice', 'agent',
            jsonb_build_object('call_id', call_id),
            NULL, NULL, call_connected_at, 'agent_calls', id,
            CASE WHEN pipeline_load_id IS NOT NULL THEN 'load-' || pipeline_load_id ELSE NULL END
          ) FROM agent_calls WHERE call_connected_at IS NOT NULL AND id > $1 AND id <= $2`,
  },
  {
    table: 'agent_calls',
    sql: `SELECT fn_insert_event(
            1, 'call.ended', 'call', id, pipeline_load_id, 'voice', 'agent',
            jsonb_build_object('call_id', call_id, 'duration_seconds', duration_seconds),
            NULL, NULL, call_ended_at, 'agent_calls', id,
            CASE WHEN pipeline_load_id IS NOT NULL THEN 'load-' || pipeline_load_id ELSE NULL END
          ) FROM agent_calls WHERE call_ended_at IS NOT NULL AND id > $1 AND id <= $2`,
  },
  {
    table: 'agent_calls',
    sql: `SELECT fn_insert_event(
            1, 'call.outcome_recorded', 'call', id, pipeline_load_id, 'voice', 'agent',
            jsonb_build_object('call_id', call_id, 'outcome', outcome, 'agreed_rate', agreed_rate),
            NULL, NULL, COALESCE(call_ended_at, call_initiated_at), 'agent_calls', id,
            CASE WHEN pipeline_load_id IS NOT NULL THEN 'load-' || pipeline_load_id ELSE NULL END
          ) FROM agent_calls WHERE outcome IS NOT NULL AND id > $1 AND id <= $2`,
  },
];

const AGENT_JOBS_STEPS: BackfillStep[] = [
  {
    table: 'agent_jobs',
    sql: `SELECT fn_insert_event(
            1, 'job.' || status, 'job', id, pipeline_load_id, queue_name, 'system',
            jsonb_build_object('job_id', job_id, 'attempts', attempts, 'error_message', error_message),
            NULL, NULL, COALESCE(completed_at, failed_at, queued_at), 'agent_jobs', id,
            CASE WHEN pipeline_load_id IS NOT NULL THEN 'load-' || pipeline_load_id ELSE NULL END
          ) FROM agent_jobs WHERE status IN ('completed', 'failed') AND id > $1 AND id <= $2`,
  },
];

const CONSENT_LOG_STEPS: BackfillStep[] = [
  {
    table: 'consent_log',
    sql: `SELECT fn_insert_event(
            1, 'consent.logged', 'consent', id, NULL, 'compliance-service', 'system',
            jsonb_build_object('phone_last4', RIGHT(phone, 4), 'consent_type', consent_type, 'consent_source', consent_source),
            NULL, NULL, consent_date, 'consent_log', id, NULL
          ) FROM consent_log WHERE id > $1 AND id <= $2`,
  },
];

const SCRAPER_RUNS_STEPS: BackfillStep[] = [
  {
    table: 'scraper_runs',
    sql: `SELECT fn_insert_event(
            COALESCE(tenant_id, 1), 'scraper.run_completed', 'scraper_run', id, NULL, 'scanner', 'system',
            jsonb_build_object('source_board', source, 'status', status, 'loads_found', loads_found,
                                'loads_inserted', loads_inserted, 'error_message', error_message),
            NULL, NULL, COALESCE(completed_at, started_at), 'scraper_runs', id, NULL
          ) FROM scraper_runs WHERE status IN ('success', 'partial', 'failed') AND id > $1 AND id <= $2`,
  },
];

export async function runBackfill(): Promise<void> {
  const allSteps = [
    ...PIPELINE_LOADS_STEPS,
    ...AGENT_CALLS_STEPS,
    ...AGENT_JOBS_STEPS,
    ...CONSENT_LOG_STEPS,
    ...SCRAPER_RUNS_STEPS,
  ];

  for (const step of allSteps) {
    await runBatched(step.table, step.sql);
  }

  console.log('\n[t17-backfill] coverage by source table:');
  const coverage = await db.query<{ derived_from_table: string; count: string }>(
    `SELECT derived_from_table, COUNT(*)::text AS count FROM events GROUP BY derived_from_table ORDER BY derived_from_table`,
  );
  for (const row of coverage.rows) {
    console.log(`  ${row.derived_from_table}: ${row.count}`);
  }
}

const isMainModule = process.argv[1]?.endsWith('t17_backfill_events.ts') ?? false;
if (isMainModule) {
  runBackfill()
    .then(() => {
      console.log('[t17-backfill] done');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[t17-backfill] failed:', err);
      process.exit(1);
    });
}
