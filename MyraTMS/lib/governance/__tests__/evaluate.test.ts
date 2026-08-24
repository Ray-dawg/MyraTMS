import { describe, it, expect } from 'vitest';
import { applyEnvelope } from '../evaluate';
import type { AuthorityEnvelopeRow } from '../types';

function baseEnvelope(overrides: Partial<AuthorityEnvelopeRow> = {}): AuthorityEnvelopeRow {
  return {
    id: 1,
    agent_id: 1,
    tenant_id: 1,
    version: 1,
    envelope_name: 'test-envelope',
    permissions: { can: ['contact_carrier'], cannot: [] },
    tools: [],
    budget: {},
    policies: {},
    confidence_threshold: 0.7,
    autonomy_default: 'L2',
    escalation_rules: [],
    is_active: true,
    effective_from: new Date().toISOString(),
    created_by: 'system',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('applyEnvelope', () => {
  it('1. clean allow: no rules, autonomy_default L2', () => {
    const r = applyEnvelope(baseEnvelope(), 'contact_carrier', {});
    expect(r.decision).toBe('allow');
    expect(r.autonomyLevelApplied).toBe('L2');
  });

  it('2. permission-list deny', () => {
    const envelope = baseEnvelope({ permissions: { can: [], cannot: ['modify_carrier_banking'] } });
    const r = applyEnvelope(envelope, 'modify_carrier_banking', {});
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('modify_carrier_banking');
  });

  it('3. budget exceeded: max_concurrent', () => {
    const envelope = baseEnvelope({ budget: { max_concurrent: 5 } });
    const r = applyEnvelope(envelope, 'place_call', { concurrentCount: 6 });
    expect(r.decision).toBe('escalate');
    expect(r.reason).toContain('max_concurrent');
  });

  it('4. budget exceeded: max_actions_per_day', () => {
    const envelope = baseEnvelope({ budget: { max_actions_per_day: 200 } });
    const r = applyEnvelope(envelope, 'place_call', { actionsToday: 201 });
    expect(r.decision).toBe('escalate');
  });

  it('5. budget exceeded: max_spend_per_day_cad', () => {
    const envelope = baseEnvelope({ budget: { max_spend_per_day_cad: 500 } });
    const r = applyEnvelope(envelope, 'place_call', { spendTodayCad: 501 });
    expect(r.decision).toBe('escalate');
  });

  it('6. budget within limits does not escalate', () => {
    const envelope = baseEnvelope({ budget: { max_concurrent: 5 } });
    const r = applyEnvelope(envelope, 'place_call', { concurrentCount: 3 });
    expect(r.decision).toBe('allow');
  });

  it('7. confidence_below_threshold matches -> L2, allow (with audit)', () => {
    const envelope = baseEnvelope({
      confidence_threshold: 0.7,
      escalation_rules: [{ trigger: 'confidence_below_threshold', level: 'L2' }],
    });
    const r = applyEnvelope(envelope, 'negotiate_rate', { confidence: 0.5 });
    expect(r.decision).toBe('allow');
    expect(r.autonomyLevelApplied).toBe('L2');
  });

  it('8. profit_above_auto_book_threshold matches -> L1, allow', () => {
    const envelope = baseEnvelope({
      policies: { auto_book_profit_threshold_cad: 1000 },
      escalation_rules: [{ trigger: 'profit_above_auto_book_threshold', level: 'L1' }],
    });
    const r = applyEnvelope(envelope, 'auto_book', { profit: 1500 });
    expect(r.decision).toBe('allow');
    expect(r.autonomyLevelApplied).toBe('L1');
  });

  it('9. margin_below_floor matches -> L3, escalate', () => {
    const envelope = baseEnvelope({
      policies: { margin_floor_pct: 8 },
      escalation_rules: [{ trigger: 'margin_below_floor', level: 'L3' }],
    });
    const r = applyEnvelope(envelope, 'book_load', { marginPct: 5 });
    expect(r.decision).toBe('escalate');
    expect(r.autonomyLevelApplied).toBe('L3');
  });

  it('10. fraud_signal_detected matches -> L3, escalate', () => {
    const envelope = baseEnvelope({
      escalation_rules: [{ trigger: 'fraud_signal_detected', level: 'L3' }],
    });
    const r = applyEnvelope(envelope, 'book_load', { fraudSignalDetected: true });
    expect(r.decision).toBe('escalate');
  });

  it('11. first-match-wins: earlier L2 rule beats a later L3 rule that also matches', () => {
    const envelope = baseEnvelope({
      confidence_threshold: 0.7,
      escalation_rules: [
        { trigger: 'confidence_below_threshold', level: 'L2' },
        { trigger: 'fraud_signal_detected', level: 'L3' },
      ],
    });
    const r = applyEnvelope(envelope, 'negotiate_rate', { confidence: 0.5, fraudSignalDetected: true });
    expect(r.autonomyLevelApplied).toBe('L2');
    expect(r.decision).toBe('allow');
  });

  it('12. unrecognized trigger name never matches; falls through to next rule', () => {
    const envelope = baseEnvelope({
      escalation_rules: [
        { trigger: 'some_future_trigger_not_yet_implemented', level: 'L3' },
        { trigger: 'fraud_signal_detected', level: 'L3' },
      ],
    });
    const r = applyEnvelope(envelope, 'book_load', { fraudSignalDetected: true });
    expect(r.decision).toBe('escalate');
    expect(r.reason).toContain('fraud_signal_detected');
  });

  it('13. empty escalation_rules falls back to autonomy_default', () => {
    const envelope = baseEnvelope({ escalation_rules: [], autonomy_default: 'L2' });
    const r = applyEnvelope(envelope, 'contact_carrier', {});
    expect(r.reason).toContain('autonomy_default');
  });

  it('14. autonomy_default L1 allows when no rules match', () => {
    const envelope = baseEnvelope({ autonomy_default: 'L1' });
    const r = applyEnvelope(envelope, 'contact_carrier', {});
    expect(r.decision).toBe('allow');
    expect(r.autonomyLevelApplied).toBe('L1');
  });

  it('15. autonomy_default L3 escalates when no rules match', () => {
    const envelope = baseEnvelope({ autonomy_default: 'L3' });
    const r = applyEnvelope(envelope, 'contact_carrier', {});
    expect(r.decision).toBe('escalate');
  });

  it('16. permission deny takes precedence over an escalation rule that would otherwise allow', () => {
    const envelope = baseEnvelope({
      permissions: { can: [], cannot: ['auto_book'] },
      escalation_rules: [{ trigger: 'profit_above_auto_book_threshold', level: 'L1' }],
      policies: { auto_book_profit_threshold_cad: 100 },
    });
    const r = applyEnvelope(envelope, 'auto_book', { profit: 500 });
    expect(r.decision).toBe('deny');
  });

  it('17. permission deny takes precedence over a budget breach', () => {
    const envelope = baseEnvelope({
      permissions: { can: [], cannot: ['place_call'] },
      budget: { max_concurrent: 1 },
    });
    const r = applyEnvelope(envelope, 'place_call', { concurrentCount: 99 });
    expect(r.decision).toBe('deny');
  });

  it('18. budget breach takes precedence over escalation rules', () => {
    const envelope = baseEnvelope({
      budget: { max_concurrent: 5 },
      escalation_rules: [{ trigger: 'fraud_signal_detected', level: 'L1' }],
    });
    const r = applyEnvelope(envelope, 'place_call', { concurrentCount: 10, fraudSignalDetected: true });
    expect(r.decision).toBe('escalate');
    expect(r.reason).toContain('budget exceeded');
  });

  it('19. boundary: marginPct exactly equal to floor does not trigger (strict <)', () => {
    const envelope = baseEnvelope({
      policies: { margin_floor_pct: 8 },
      escalation_rules: [{ trigger: 'margin_below_floor', level: 'L3' }],
    });
    const r = applyEnvelope(envelope, 'book_load', { marginPct: 8 });
    expect(r.decision).not.toBe('escalate');
  });

  it('20. boundary: confidence exactly equal to threshold does not trigger (strict <)', () => {
    const envelope = baseEnvelope({
      confidence_threshold: 0.7,
      escalation_rules: [{ trigger: 'confidence_below_threshold', level: 'L2' }],
    });
    const r = applyEnvelope(envelope, 'negotiate_rate', { confidence: 0.7 });
    expect(r.reason).toContain('autonomy_default');
  });

  it('21. boundary: profit exactly equal to threshold does not trigger (strict >)', () => {
    const envelope = baseEnvelope({
      policies: { auto_book_profit_threshold_cad: 1000 },
      escalation_rules: [{ trigger: 'profit_above_auto_book_threshold', level: 'L1' }],
    });
    const r = applyEnvelope(envelope, 'auto_book', { profit: 1000 });
    expect(r.reason).toContain('autonomy_default');
  });

  it('22. missing context field evaluates the trigger as false, does not throw', () => {
    const envelope = baseEnvelope({
      escalation_rules: [{ trigger: 'margin_below_floor', level: 'L3' }],
      policies: { margin_floor_pct: 8 },
    });
    expect(() => applyEnvelope(envelope, 'book_load', {})).not.toThrow();
    expect(applyEnvelope(envelope, 'book_load', {}).decision).not.toBe('escalate');
  });

  it('23. deny reason references the action name', () => {
    const envelope = baseEnvelope({ permissions: { can: [], cannot: ['approve_high_risk_payer'] } });
    const r = applyEnvelope(envelope, 'approve_high_risk_payer', {});
    expect(r.reason).toContain('approve_high_risk_payer');
  });

  it('24. envelopeId is propagated regardless of decision path', () => {
    const envelope = baseEnvelope({ id: 42, permissions: { can: [], cannot: ['x'] } });
    expect(applyEnvelope(envelope, 'x', {}).envelopeId).toBe(42);
    expect(applyEnvelope(baseEnvelope({ id: 42 }), 'y', {}).envelopeId).toBe(42);
  });
});
