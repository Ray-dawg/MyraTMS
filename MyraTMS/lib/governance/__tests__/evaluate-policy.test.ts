import { describe, it, expect } from 'vitest';
import { applyPolicy } from '../evaluate-policy';
import type { CoBrokerAgreementRow, TenantPolicyRow } from '../policy-types';

function basePolicy(overrides: Partial<TenantPolicyRow> = {}): TenantPolicyRow {
  return {
    id: 1,
    tenant_id: 2,
    version: 1,
    load_source_policy: 'shipper_direct_or_coBroker',
    dispatch_agent_enabled: true,
    negotiation_directions: 'both',
    geographic_scope: { domestic_only: true, countries: ['CA'] },
    margin_floor_pct: null,
    is_active: true,
    effective_from: new Date().toISOString(),
    created_by: 'system',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function domesticLoad(overrides: Partial<Parameters<typeof applyPolicy>[1]> = {}) {
  return {
    isDirect: true,
    postingSource: 'manual',
    originCountry: 'CA',
    destinationCountry: 'CA',
    ...overrides,
  };
}

function activeAgreement(mcNumber: string): CoBrokerAgreementRow {
  return {
    id: 1,
    tenant_id: 2,
    counterparty_name: 'Test Broker Co',
    counterparty_mc_number: mcNumber,
    agreement_executed_at: '2026-01-01',
    status: 'active',
  };
}

describe('applyPolicy', () => {
  it('1. shipper-direct load accepted (Broker template default)', () => {
    const r = applyPolicy(basePolicy(), domesticLoad({ isDirect: true }), []);
    expect(r.decision).toBe('accept');
  });

  it('2. broker-posted load with no co-broker agreement rejected', () => {
    const r = applyPolicy(basePolicy(), domesticLoad({ isDirect: false, postingCompanyMcNumber: 'MC123' }), []);
    expect(r.decision).toBe('reject');
    expect(r.reason).toContain('no active co-broker agreement');
  });

  it('3. broker-posted load with a matching active co-broker agreement accepted', () => {
    const r = applyPolicy(
      basePolicy(),
      domesticLoad({ isDirect: false, postingCompanyMcNumber: 'MC123' }),
      [activeAgreement('MC123')],
    );
    expect(r.decision).toBe('accept');
    expect(r.reason).toContain('MC123');
  });

  it('4. broker-posted load with an agreement for a DIFFERENT MC number still rejected', () => {
    const r = applyPolicy(
      basePolicy(),
      domesticLoad({ isDirect: false, postingCompanyMcNumber: 'MC999' }),
      [activeAgreement('MC123')],
    );
    expect(r.decision).toBe('reject');
  });

  it('5. broker-posted load with a matching but EXPIRED agreement rejected (only status=active counts)', () => {
    const expired: CoBrokerAgreementRow = { ...activeAgreement('MC123'), status: 'expired' };
    const r = applyPolicy(basePolicy(), domesticLoad({ isDirect: false, postingCompanyMcNumber: 'MC123' }), [expired]);
    expect(r.decision).toBe('reject');
  });

  it('6. broker-posted load with a matching but TERMINATED agreement rejected', () => {
    const terminated: CoBrokerAgreementRow = { ...activeAgreement('MC123'), status: 'terminated' };
    const r = applyPolicy(basePolicy(), domesticLoad({ isDirect: false, postingCompanyMcNumber: 'MC123' }), [terminated]);
    expect(r.decision).toBe('reject');
  });

  it('7. cross-border load rejected under a domestic-only policy, regardless of load source', () => {
    const r = applyPolicy(basePolicy(), domesticLoad({ isDirect: true, destinationCountry: 'US' }), []);
    expect(r.decision).toBe('reject');
    expect(r.reason).toContain('geographic scope');
  });

  it('8. cross-border check happens before the load-source check (geographic rejection even for shipper-direct)', () => {
    const r = applyPolicy(basePolicy(), domesticLoad({ isDirect: true, originCountry: 'US', destinationCountry: 'CA' }), []);
    expect(r.decision).toBe('reject');
  });

  it('9. non-domestic-only policy allows a cross-border load through to the load-source check', () => {
    const policy = basePolicy({ geographic_scope: { domestic_only: false, countries: [] }, load_source_policy: 'any' });
    const r = applyPolicy(policy, domesticLoad({ isDirect: false, originCountry: 'US', destinationCountry: 'CA' }), []);
    expect(r.decision).toBe('accept');
  });

  it("10. load_source_policy='any' accepts a broker-posted load with no agreement (Carrier template)", () => {
    const policy = basePolicy({ load_source_policy: 'any' });
    const r = applyPolicy(policy, domesticLoad({ isDirect: false }), []);
    expect(r.decision).toBe('accept');
  });

  it("11. load_source_policy='broker_or_shipper_direct' accepts broker-posted with no agreement (Dispatcher template)", () => {
    const policy = basePolicy({ load_source_policy: 'broker_or_shipper_direct' });
    const r = applyPolicy(policy, domesticLoad({ isDirect: false }), []);
    expect(r.decision).toBe('accept');
  });

  it("12. load_source_policy='broker_or_shipper_direct' also accepts shipper-direct", () => {
    const policy = basePolicy({ load_source_policy: 'broker_or_shipper_direct' });
    const r = applyPolicy(policy, domesticLoad({ isDirect: true }), []);
    expect(r.decision).toBe('accept');
  });

  it("13. load_source_policy='inherit' fails closed (Acquired Opco not yet resolved to a concrete type)", () => {
    const policy = basePolicy({ load_source_policy: 'inherit' });
    const r = applyPolicy(policy, domesticLoad({ isDirect: true }), []);
    expect(r.decision).toBe('reject');
    expect(r.reason).toContain('inherit');
  });

  it('14. unrecognized load_source_policy value fails closed rather than throwing', () => {
    const policy = basePolicy({ load_source_policy: 'not_a_real_policy' });
    expect(() => applyPolicy(policy, domesticLoad(), [])).not.toThrow();
    expect(applyPolicy(policy, domesticLoad(), []).decision).toBe('reject');
  });

  it('15. policyId is propagated regardless of decision path', () => {
    const policy = basePolicy({ id: 77 });
    expect(applyPolicy(policy, domesticLoad({ isDirect: true }), []).policyId).toBe(77);
    expect(applyPolicy(policy, domesticLoad({ destinationCountry: 'US' }), []).policyId).toBe(77);
  });

  it('16. missing geographic_scope defaults to no restriction (does not throw)', () => {
    const policy = basePolicy({ geographic_scope: undefined as unknown as TenantPolicyRow['geographic_scope'] });
    expect(() => applyPolicy(policy, domesticLoad({ destinationCountry: 'US' }), [])).not.toThrow();
  });

  it('17. multiple active agreements: matches on any one of them', () => {
    const r = applyPolicy(
      basePolicy(),
      domesticLoad({ isDirect: false, postingCompanyMcNumber: 'MC456' }),
      [activeAgreement('MC123'), activeAgreement('MC456')],
    );
    expect(r.decision).toBe('accept');
  });
});
