/**
 * E2-01 M2 — downstream load-source assertions (PRD §5).
 *
 * The Qualifier decides (F1); the Compiler and Dispatcher *assert*. Three
 * enforcement points, never one (E3-R2, double-brokering). If a load with a
 * non-accepted class ever reaches either worker under enforce mode,
 * something injected it mid-pipeline: escalate as critical, build nothing.
 */
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { getShipperDirectGateMode, getGateEnforcedAt, type EnvLike } from '@/lib/pipeline/gate-mode';

const ACCEPTED = new Set(['shipper_direct', 'co_brokered']);

export type AssertionStage = 'compiler' | 'dispatcher';

export type SourceAssertion =
  | { ok: true }
  | { ok: false; reasonCode: 'source_assertion_failed_compiler' | 'source_assertion_failed_dispatcher'; detail: string };

export function assertLoadSource(
  load: { load_source_class: string | null; created_at: Date | string | null },
  stage: AssertionStage,
  env: EnvLike = process.env,
): SourceAssertion {
  if (getShipperDirectGateMode(env) !== 'enforce') return { ok: true };

  // PRD §4.14 step 3 — rows qualified before enforcement went live carry no
  // class and are tolerated; the expiry sweeper drains them within 72 h.
  const enforcedAt = getGateEnforcedAt(env);
  const createdAt = load.created_at ? new Date(load.created_at) : null;
  if (enforcedAt && createdAt && !Number.isNaN(createdAt.getTime()) && createdAt < enforcedAt) return { ok: true };

  if (load.load_source_class && ACCEPTED.has(load.load_source_class)) return { ok: true };

  return {
    ok: false,
    reasonCode: stage === 'compiler' ? 'source_assertion_failed_compiler' : 'source_assertion_failed_dispatcher',
    detail: `load_source_class=${load.load_source_class ?? 'NULL'} reached the ${stage} under enforce mode — something injected a load mid-pipeline`,
  };
}

export async function escalateSourceAssertion(
  pipelineLoadId: number,
  assertion: Extract<SourceAssertion, { ok: false }>,
): Promise<void> {
  await db.query(
    `UPDATE pipeline_loads
        SET stage = 'escalated', stage_updated_at = NOW(),
            qualification_reason = $2, qualification_detail = $3, updated_at = NOW()
      WHERE id = $1`,
    [pipelineLoadId, assertion.reasonCode, assertion.detail],
  );
  await db.query(
    `INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail, pipeline_load_id, source_module, suggested_action, sla_due_at)
     VALUES (NULL, NULL, 'load_source_assertion', 'critical', $1, $2, $3, 'load_source_assertion',
             'Find out how this load bypassed the Qualifier gate. Do not release it.', NOW() + INTERVAL '1 hour')`,
    [`Source assertion failed: ${assertion.reasonCode}`, assertion.detail, pipelineLoadId],
  );
  logger.error(`[load-source-assert] load ${pipelineLoadId}: ${assertion.detail}`);
}
