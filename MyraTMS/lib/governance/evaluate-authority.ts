import { db } from '@/lib/pipeline/db-adapter';
import { applyEnvelope } from './evaluate';
import type { AuthorityEnvelopeRow, EvaluationInput, EvaluationResult } from './types';

export async function evaluateAuthority(input: EvaluationInput): Promise<EvaluationResult> {
  const { agentKey, tenantId, action, context, sourceEventId, pipelineLoadId, correlationId } = input;

  const agentRow = await db.query<{ id: number }>(`SELECT id FROM agents WHERE agent_key = $1`, [agentKey]);
  if (agentRow.rows.length === 0) {
    throw new Error(`evaluateAuthority: unknown agent_key '${agentKey}'`);
  }
  const agentId = agentRow.rows[0].id;

  const envelopeRow = await db.query<AuthorityEnvelopeRow>(
    `SELECT id, agent_id, tenant_id, version, envelope_name, permissions, tools, budget, policies,
            confidence_threshold, autonomy_default, escalation_rules, is_active, effective_from,
            created_by, created_at
       FROM authority_envelopes
      WHERE agent_id = $1 AND tenant_id = $2 AND is_active = true
      LIMIT 1`,
    [agentId, tenantId],
  );
  if (envelopeRow.rows.length === 0) {
    throw new Error(`evaluateAuthority: no active envelope for agent_key='${agentKey}' tenant_id=${tenantId}`);
  }
  const envelope = envelopeRow.rows[0];

  const result = applyEnvelope(envelope, action, context);

  const insertResult = await db.query<{ id: number }>(
    `INSERT INTO authority_evaluations (
       envelope_id, agent_id, tenant_id, pipeline_load_id, action, context,
       autonomy_level_applied, decision, reason, shadow_mode, source_event_id, correlation_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11)
     ON CONFLICT (source_event_id) DO NOTHING
     RETURNING id`,
    [
      envelope.id, agentId, tenantId, pipelineLoadId ?? null, action, JSON.stringify(context),
      result.autonomyLevelApplied, result.decision, result.reason,
      sourceEventId ?? null, correlationId ?? null,
    ],
  );

  let evaluationId: number;
  if (insertResult.rows.length > 0) {
    evaluationId = insertResult.rows[0].id;
  } else if (sourceEventId != null) {
    // Already evaluated this source event in a prior replay run — idempotent no-op.
    const existing = await db.query<{
      id: number; decision: string; autonomy_level_applied: string; reason: string;
    }>(
      `SELECT id, decision, autonomy_level_applied, reason FROM authority_evaluations WHERE source_event_id = $1`,
      [sourceEventId],
    );
    const row = existing.rows[0];
    return {
      decision: row.decision as EvaluationResult['decision'],
      autonomyLevelApplied: row.autonomy_level_applied as EvaluationResult['autonomyLevelApplied'],
      reason: row.reason,
      envelopeId: envelope.id,
    };
  } else {
    throw new Error('evaluateAuthority: insert returned no row and sourceEventId is null — unexpected');
  }

  if (result.decision === 'escalate') {
    await db.query(
      `INSERT INTO escalations (evaluation_id, tenant_id, pipeline_load_id, severity, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [evaluationId, tenantId, pipelineLoadId ?? null, result.autonomyLevelApplied === 'L3' ? 'high' : 'medium'],
    );
  }

  return result;
}
