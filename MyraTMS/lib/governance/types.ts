export interface EscalationRule {
  trigger: string;
  level: 'L1' | 'L2' | 'L3';
}

export interface AuthorityEnvelopeRow {
  id: number;
  agent_id: number;
  tenant_id: number;
  version: number;
  envelope_name: string;
  permissions: { can: string[]; cannot: string[] };
  tools: string[];
  budget: Record<string, number>;
  policies: Record<string, number>;
  confidence_threshold: number;
  autonomy_default: 'L1' | 'L2' | 'L3';
  escalation_rules: EscalationRule[];
  is_active: boolean;
  effective_from: string;
  created_by: string;
  created_at: string;
}

export interface EvaluationInput {
  agentKey: string;
  tenantId: number;
  action: string;
  context: Record<string, unknown>;
  sourceEventId?: number;
  pipelineLoadId?: number;
  correlationId?: string;
}

export interface EvaluationResult {
  decision: 'allow' | 'escalate' | 'deny';
  autonomyLevelApplied: 'L1' | 'L2' | 'L3';
  reason: string;
  envelopeId: number;
}
