// lib/risk/__tests__/carrier-risk-scoring.test.ts
import { describe, it, expect } from 'vitest';
import { computeCarrierRiskSeverity } from '@/lib/risk/carrier-risk-scoring';

describe('computeCarrierRiskSeverity', () => {
  it('scores banking_change_mid_transaction as critical', () => {
    expect(computeCarrierRiskSeverity('banking_change_mid_transaction')).toBe('critical');
  });
  it('scores insurance_lapsed and authority_reassigned as high', () => {
    expect(computeCarrierRiskSeverity('insurance_lapsed')).toBe('high');
    expect(computeCarrierRiskSeverity('authority_reassigned')).toBe('high');
  });
  it('scores excessive_cancellation_rate and name_mismatch as medium', () => {
    expect(computeCarrierRiskSeverity('excessive_cancellation_rate')).toBe('medium');
    expect(computeCarrierRiskSeverity('name_mismatch')).toBe('medium');
  });
  it('falls back to medium for an unrecognized signal type rather than throwing', () => {
    expect(computeCarrierRiskSeverity('some_future_signal_type')).toBe('medium');
  });
});
