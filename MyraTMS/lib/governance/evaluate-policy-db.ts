import { db } from '@/lib/pipeline/db-adapter';
import { applyPolicy } from './evaluate-policy';
import type { CoBrokerAgreementRow, PolicyEvaluationInput, PolicyEvaluationResult, TenantPolicyRow } from './policy-types';

/**
 * DB wrapper (T-19 §5, steps 1, 4-5). Loads the active tenant_policies row
 * and active co_broker_agreements, calls the pure applyPolicy(), and logs
 * into T-18's authority_evaluations under the 'policy_engine' agent — a
 * policy decision and an authority decision are the same kind of record
 * (T-19 §5). Idempotent on source_event_id, same pattern as
 * evaluateAuthority(). accept/reject maps to allow/deny when logged, since
 * authority_evaluations' decision vocabulary is allow/escalate/deny.
 */
export async function evaluatePolicy(input: PolicyEvaluationInput): Promise<PolicyEvaluationResult> {
  const { tenantId, load, pipelineLoadId, sourceEventId, correlationId } = input;

  const policyRow = await db.query<TenantPolicyRow>(
    `SELECT id, tenant_id, version, load_source_policy, dispatch_agent_enabled, negotiation_directions,
            geographic_scope, margin_floor_pct, is_active, effective_from, created_by, created_at
       FROM tenant_policies
      WHERE tenant_id = $1 AND is_active = true
      LIMIT 1`,
    [tenantId],
  );
  if (policyRow.rows.length === 0) {
    throw new Error(`evaluatePolicy: no active tenant_policies row for tenant_id=${tenantId}`);
  }
  const policy = policyRow.rows[0];

  const agreements = await db.query<CoBrokerAgreementRow>(
    `SELECT id, tenant_id, counterparty_name, counterparty_mc_number, agreement_executed_at, status
       FROM co_broker_agreements
      WHERE tenant_id = $1 AND status = 'active'`,
    [tenantId],
  );

  const result = applyPolicy(policy, load, agreements.rows);

  const agentRow = await db.query<{ id: number }>(`SELECT id FROM agents WHERE agent_key = 'policy_engine'`);
  const agentId = agentRow.rows[0]?.id;
  if (!agentId) {
    throw new Error(`evaluatePolicy: 'policy_engine' agent not seeded — run migration 035`);
  }

  const envelopeRow = await db.query<{ id: number }>(
    `SELECT id FROM authority_envelopes WHERE agent_id = $1 AND tenant_id = $2 AND is_active = true LIMIT 1`,
    [agentId, tenantId],
  );
  const envelopeId = envelopeRow.rows[0]?.id;
  if (!envelopeId) {
    throw new Error(`evaluatePolicy: no active envelope for 'policy_engine' on tenant_id=${tenantId}`);
  }

  await db.query(
    `INSERT INTO authority_evaluations (
       envelope_id, agent_id, tenant_id, pipeline_load_id, action, context,
       autonomy_level_applied, decision, reason, shadow_mode, source_event_id, correlation_id
     ) VALUES ($1, $2, $3, $4, 'evaluate_load_source_policy', $5, 'L2', $6, $7, true, $8, $9)
     ON CONFLICT (source_event_id) DO NOTHING`,
    [
      envelopeId,
      agentId,
      tenantId,
      pipelineLoadId ?? null,
      JSON.stringify(load),
      result.decision === 'accept' ? 'allow' : 'deny',
      result.reason,
      sourceEventId ?? null,
      correlationId ?? null,
    ],
  );

  return result;
}
