// lib/exceptions/bridge.ts
//
// T-24 §4.4 — normalizes signals from sources 1-5 (spec §1) into the
// existing `exceptions` table, via the SAME check-before-insert dedup
// discipline lib/exceptions/detector.ts and lib/pipeline/health-checks.ts
// already use (SELECT ... WHERE type=$1 AND <link> AND status='active'
// LIMIT 1, skip insert if found). Read-only against every source table;
// writes only to `exceptions` (plus, for carrier_risk, a `reviewed=true`
// flag-back on its own source row — see pollCarrierRisk()).

import { db } from '@/lib/pipeline/db-adapter';
import { withTenant } from '@/lib/db/tenant-context';
import { logger } from '@/lib/logger';
import { getMyraTenantId } from '@/lib/tenants/get-myra-tenant-id';
import { matchClassificationRule } from './classification-rules';

export interface SourceSignal {
  tenantId: number;
  sourceModule: 'authority_shadow' | 'lifecycle_late' | 'carrier_risk' | 'stage_escalated' | 'dead_letter'
    | 'payer_risk' | 'transaction_halt'; // T-25 extension — no other line in this file changes
  exceptionType: string;
  title: string;
  description: string;
  context: Record<string, number>;
  pipelineLoadId: number | null;
  loadId: string | null;
  carrierId: string | null;
}

export async function bridgeToExceptions(source: SourceSignal): Promise<boolean> {
  // T-18's escalations rows are all shadow-mode until T-18b ships — this
  // bridge does not itself decide to promote a shadow evaluation (spec §4.4).
  if (source.sourceModule === 'authority_shadow') return false;

  const rule = await matchClassificationRule(source.tenantId, source.sourceModule, source.context);
  if (!rule) return false;

  return withTenant(source.tenantId, async (client) => {
    const dedupParams: unknown[] = [source.exceptionType];
    let dedupClause = 'type = $1';
    if (source.loadId) {
      dedupClause += ' AND load_id = $2';
      dedupParams.push(source.loadId);
    } else if (source.pipelineLoadId) {
      dedupClause += ' AND pipeline_load_id = $2';
      dedupParams.push(source.pipelineLoadId);
    } else if (source.carrierId) {
      dedupClause += ' AND carrier_id = $2';
      dedupParams.push(source.carrierId);
    } else {
      dedupClause += ' AND title = $2';
      dedupParams.push(source.title);
    }

    const exists = await client.query(
      `SELECT 1 FROM exceptions WHERE ${dedupClause} AND status = 'active' LIMIT 1`,
      dedupParams,
    );
    if (exists.rows.length > 0) return false;

    await client.query(
      `INSERT INTO exceptions (
         load_id, carrier_id, type, severity, title, detail,
         tenant_id, pipeline_load_id, source_module, suggested_action, sla_due_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + ($11 || ' minutes')::interval)`,
      [
        source.loadId, source.carrierId, source.exceptionType, rule.severity,
        source.title, source.description, source.tenantId, source.pipelineLoadId,
        source.sourceModule, rule.suggestedAction, rule.slaMinutes,
      ],
    );
    return true;
  });
}

interface PollResult { found: number; written: number }

/** T-23's v_lifecycle_late_loads, where late_status IS NOT NULL. */
export async function pollLifecycleLate(): Promise<PollResult> {
  const tenantId = await getMyraTenantId();
  let found = 0;
  let written = 0;
  try {
    const { rows } = await db.query<{
      pipeline_load_id: number; late_status: string; time_overdue_minutes: number;
    }>(`
      SELECT pipeline_load_id, late_status, EXTRACT(EPOCH FROM time_overdue) / 60 AS time_overdue_minutes
        FROM v_lifecycle_late_loads
       WHERE late_status IS NOT NULL
    `);
    found = rows.length;
    for (const row of rows) {
      const wrote = await bridgeToExceptions({
        tenantId,
        sourceModule: 'lifecycle_late',
        exceptionType: row.late_status,
        title: `${row.late_status === 'pickup_late' ? 'Pickup' : 'Delivery'} late — pipeline load ${row.pipeline_load_id}`,
        description: `${Math.round(row.time_overdue_minutes)} minutes overdue with no matching lifecycle event recorded.`,
        context: { time_overdue_minutes: row.time_overdue_minutes },
        pipelineLoadId: row.pipeline_load_id,
        loadId: null,
        carrierId: null,
      });
      if (wrote) written++;
    }
  } catch (err) {
    logger.error('[exceptions/bridge] pollLifecycleLate crash', err);
  }
  return { found, written };
}

/** T-20's carrier_risk_signals, where reviewed = false. Flags the source
 * row reviewed=true right after a successful bridge — that flag IS this
 * poller's dedup mechanism (a reviewed row is never re-read), same
 * "derive from what already exists" discipline as the rest of this codebase. */
export async function pollCarrierRisk(): Promise<PollResult> {
  const tenantId = await getMyraTenantId();
  let found = 0;
  let written = 0;
  try {
    const { rows } = await db.query<{
      id: number; carrier_registry_id: number; signal_type: string; severity: string; carrier_id: string | null;
    }>(`
      SELECT crs.id, crs.carrier_registry_id, crs.signal_type, crs.severity, c.id AS carrier_id
        FROM carrier_risk_signals crs
        LEFT JOIN carriers c ON c.carrier_registry_id = crs.carrier_registry_id
       WHERE crs.reviewed = false
    `);
    found = rows.length;
    for (const row of rows) {
      const wrote = await bridgeToExceptions({
        tenantId,
        sourceModule: 'carrier_risk',
        exceptionType: 'carrier_risk_signal',
        title: `Carrier risk signal: ${row.signal_type} (carrier_registry_id=${row.carrier_registry_id})`,
        description: `T-20 flagged this carrier with a '${row.signal_type}' risk signal (source severity: ${row.severity}).`,
        context: {},
        pipelineLoadId: null,
        loadId: null,
        carrierId: row.carrier_id,
      });
      if (wrote) written++;
      await db.query(`UPDATE carrier_risk_signals SET reviewed = true WHERE id = $1`, [row.id]);
    }
  } catch (err) {
    logger.error('[exceptions/bridge] pollCarrierRisk crash', err);
  }
  return { found, written };
}

/** pipeline_loads where stage = 'escalated' and no active bridged exception exists yet. */
export async function pollStageEscalated(): Promise<PollResult> {
  const tenantId = await getMyraTenantId();
  let found = 0;
  let written = 0;
  try {
    const { rows } = await db.query<{ id: number; load_id: string; origin_city: string; destination_city: string }>(`
      SELECT id, load_id, origin_city, destination_city FROM pipeline_loads WHERE stage = 'escalated'
    `);
    found = rows.length;
    for (const row of rows) {
      const wrote = await bridgeToExceptions({
        tenantId,
        sourceModule: 'stage_escalated',
        exceptionType: 'pipeline_stage_escalated',
        title: `Pipeline load escalated: ${row.origin_city} → ${row.destination_city}`,
        description: `pipeline_loads.id=${row.id} (load_id ${row.load_id}) is in the 'escalated' stage.`,
        context: {},
        pipelineLoadId: row.id,
        loadId: null,
        carrierId: null,
      });
      if (wrote) written++;
    }
  } catch (err) {
    logger.error('[exceptions/bridge] pollStageEscalated crash', err);
  }
  return { found, written };
}

/** agent_jobs where status = 'dead_letter'. Dedup by (type, title) since
 * exceptions has no job_id column and a job isn't reliably tied to one load. */
export async function pollDeadLetterJobs(): Promise<PollResult> {
  const tenantId = await getMyraTenantId();
  let found = 0;
  let written = 0;
  try {
    const { rows } = await db.query<{
      job_id: string; queue_name: string; pipeline_load_id: number | null; error_message: string | null;
    }>(`
      SELECT job_id, queue_name, pipeline_load_id, error_message FROM agent_jobs WHERE status = 'dead_letter'
    `);
    found = rows.length;
    for (const row of rows) {
      const title = `Dead-lettered job: ${row.job_id} (queue: ${row.queue_name})`;
      const wrote = await bridgeToExceptions({
        tenantId,
        sourceModule: 'dead_letter',
        exceptionType: 'agent_job_dead_letter',
        title,
        description: row.error_message || 'Job exhausted retries and was moved to the dead-letter queue.',
        context: {},
        pipelineLoadId: row.pipeline_load_id,
        loadId: null,
        carrierId: null,
      });
      if (wrote) written++;
    }
  } catch (err) {
    logger.error('[exceptions/bridge] pollDeadLetterJobs crash', err);
  }
  return { found, written };
}

export async function runExceptionBridge(): Promise<PollResult> {
  const results = await Promise.all([pollLifecycleLate(), pollCarrierRisk(), pollStageEscalated(), pollDeadLetterJobs()]);
  return results.reduce((acc, r) => ({ found: acc.found + r.found, written: acc.written + r.written }), { found: 0, written: 0 });
}
