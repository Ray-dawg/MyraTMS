export interface TenantPolicyRow {
  id: number;
  tenant_id: number;
  version: number;
  load_source_policy: string; // 'shipper_direct_or_coBroker' | 'broker_or_shipper_direct' | 'any' | 'inherit'
  dispatch_agent_enabled: boolean;
  negotiation_directions: string;
  geographic_scope: { domestic_only: boolean; countries: string[] };
  margin_floor_pct: number | null;
  is_active: boolean;
  effective_from: string;
  created_by: string;
  created_at: string;
}

export interface CoBrokerAgreementRow {
  id: number;
  tenant_id: number;
  counterparty_name: string;
  counterparty_mc_number: string | null;
  agreement_executed_at: string;
  status: 'active' | 'expired' | 'terminated';
}

export interface PolicyEvaluationLoad {
  isDirect: boolean;
  postingSource: string;
  postingCompanyMcNumber?: string;
  originCountry: string;
  destinationCountry: string;
}

export interface PolicyEvaluationInput {
  tenantId: number;
  load: PolicyEvaluationLoad;
  pipelineLoadId?: number;
  sourceEventId?: number;
  correlationId?: string;
}

export interface PolicyEvaluationResult {
  decision: 'accept' | 'reject';
  reason: string;
  policyId: number;
}
