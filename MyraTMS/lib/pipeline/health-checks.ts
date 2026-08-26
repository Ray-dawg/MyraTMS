/**
 * E2-03 M5 — pipeline_loads health checks. Extracted out of
 * app/api/cron/pipeline-health/route.ts so they're directly testable
 * (this codebase's established convention — see lib/dispatch-gate.ts,
 * lib/pipeline/carrier-cascade.ts, lib/workers/dispatcher-worker.ts, all
 * tested by calling the lib function directly rather than through their
 * route/queue wrapper).
 *
 * Purely observational: both functions only write `exceptions` rows, no
 * automated remediation, per PRD §9.
 */

import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';

interface StuckLoadRow {
  id: number;
  stage: string;
  load_id: string;
  origin_city: string;
  origin_state: string;
  destination_city: string;
  destination_state: string;
}

interface LatePickupRow {
  id: number;
  load_id: string;
  pickup_date: Date | string;
  stage: string;
  origin_city: string;
  origin_state: string;
}

async function writeExceptionOnce(params: {
  pipelineLoadId: number;
  type: string;
  severity: string;
  title: string;
  detail: string;
  suggestedAction: string;
  slaHours: number;
}): Promise<boolean> {
  const exists = await db.query(
    `SELECT 1 FROM exceptions WHERE type = $1 AND pipeline_load_id = $2 AND status = 'active' LIMIT 1`,
    [params.type, params.pipelineLoadId],
  );
  if (exists.rows.length > 0) return false;

  await db.query(
    `INSERT INTO exceptions (
       load_id, carrier_id, type, severity, title, detail,
       pipeline_load_id, source_module, suggested_action, sla_due_at
     ) VALUES (
       NULL, NULL, $1, $2, $3, $4,
       $5, 'pipeline_health_cron', $6, NOW() + ($7 || ' hours')::interval
     )`,
    [params.type, params.severity, params.title, params.detail, params.pipelineLoadId, params.suggestedAction, String(params.slaHours)],
  );
  return true;
}

/**
 * Anything in a non-terminal stage that hasn't moved in 60+ minutes, plus
 * 'dispatched' specifically at 24+ hours (it legitimately persists for the
 * whole transit duration, so it gets its own longer threshold rather than
 * being excluded entirely — the exclusion this closes: a pipeline_loads row
 * desynced from its linked TMS loads row (e.g. advanceDeliveredLoads()
 * never ran, or the join silently matched nothing) would previously be
 * invisible forever once dispatched).
 */
export async function detectStuckPipelineLoads(): Promise<{ found: number; written: number }> {
  let found = 0;
  let written = 0;
  try {
    const r = await db.query<StuckLoadRow>(
      `SELECT id, stage, load_id, origin_city, origin_state, destination_city, destination_state
       FROM pipeline_loads
       WHERE (
         stage NOT IN ('disqualified','scored','expired','delivered','dispatched')
         AND stage_updated_at < NOW() - INTERVAL '60 minutes'
       )
       OR (
         stage = 'dispatched'
         AND stage_updated_at < NOW() - INTERVAL '24 hours'
       )`,
    );
    found = r.rows.length;

    for (const row of r.rows) {
      const wrote = await writeExceptionOnce({
        pipelineLoadId: row.id,
        type: 'pipeline_stage_stuck',
        severity: row.stage === 'dispatched' ? 'medium' : 'high',
        title: `Pipeline load stuck at '${row.stage}': ${row.origin_city}, ${row.origin_state} → ${row.destination_city}, ${row.destination_state}`,
        detail:
          `pipeline_loads.id=${row.id} (load_id ${row.load_id}) has not advanced past '${row.stage}' in ` +
          `${row.stage === 'dispatched' ? '24+ hours' : '60+ minutes'}.`,
        suggestedAction: 'Investigate why this load is not progressing — check agent_jobs for failures, or advance/escalate manually.',
        slaHours: 4,
      });
      if (wrote) written++;
    }

    if (found > 0) {
      logger.warn('[health-checks] stuck loads detected', { count: found, written });
    }
  } catch (err) {
    logger.error('[health-checks] stuck-load query crash', err);
  }
  return { found, written };
}

/**
 * A pipeline_load whose pickup_date has already passed while still in a
 * non-terminal, pre-dispatch stage — genuinely invisible to the buy-side
 * lib/exceptions/detector.ts, which keys off loads.status and only starts
 * seeing a load once a TMS loads row exists (i.e. once dispatched). Once a
 * load reaches 'dispatched' it IS covered by that existing detector, so
 * this check stops at the dispatch boundary rather than duplicating it.
 */
export async function detectMissedPickupWindows(): Promise<{ found: number; written: number }> {
  let found = 0;
  let written = 0;
  try {
    const r = await db.query<LatePickupRow>(
      `SELECT id, load_id, pickup_date, stage, origin_city, origin_state
       FROM pipeline_loads
       WHERE stage NOT IN ('disqualified','scored','expired','delivered','dispatched')
         AND pickup_date < NOW() - INTERVAL '4 hours'`,
    );
    found = r.rows.length;

    for (const row of r.rows) {
      const pickupIso = (row.pickup_date instanceof Date ? row.pickup_date : new Date(row.pickup_date)).toISOString();
      const wrote = await writeExceptionOnce({
        pipelineLoadId: row.id,
        type: 'pipeline_load_missed_pickup_window',
        severity: 'high',
        title: `Pickup window missed: ${row.origin_city}, ${row.origin_state}`,
        detail:
          `pipeline_loads.id=${row.id} (load_id ${row.load_id}) has pickup_date ${pickupIso} in the past while ` +
          `still at stage '${row.stage}' — no carrier has been dispatched.`,
        suggestedAction: 'Manually source a carrier or mark this load disqualified/expired.',
        slaHours: 2,
      });
      if (wrote) written++;
    }

    if (found > 0) {
      logger.warn('[health-checks] missed pickup windows detected', { count: found, written });
    }
  } catch (err) {
    logger.error('[health-checks] late-pickup query crash', err);
  }
  return { found, written };
}
