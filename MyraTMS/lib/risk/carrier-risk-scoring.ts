// lib/risk/carrier-risk-scoring.ts
//
// T-25 §2 — "adds severity computation" for T-20's carrier_risk_signals
// signal types (migration 044's comment lists the 6 named types). Pure
// function, used by the GET /api/risk/carrier/:id endpoint and a future
// backfill — deliberately NOT wired into lib/exceptions/bridge.ts's
// existing pollCarrierRisk(), which stays untouched per Global Constraints.

export type RiskSeverity = 'low' | 'medium' | 'high' | 'critical';

const SEVERITY_BY_SIGNAL_TYPE: Record<string, RiskSeverity> = {
  banking_change_mid_transaction: 'critical',
  insurance_lapsed: 'high',
  authority_reassigned: 'high',
  multiple_mc_same_contact: 'high',
  excessive_cancellation_rate: 'medium',
  name_mismatch: 'medium',
};

export function computeCarrierRiskSeverity(signalType: string): RiskSeverity {
  return SEVERITY_BY_SIGNAL_TYPE[signalType] ?? 'medium';
}
