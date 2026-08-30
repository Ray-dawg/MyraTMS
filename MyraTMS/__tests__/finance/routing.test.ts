import { describe, it, expect } from 'vitest';
import { decideRoute } from '@/lib/finance/routing';

describe('decideRoute (T-27 §5/§6.3 routing table)', () => {
  it('declines on unknown payer credit regardless of other inputs', () => {
    expect(decideRoute({ payerCreditLevel: 'unknown', carrierWantsQuickPay: false, floatCapacityAvailable: true }).route).toBe('DECLINE');
    expect(decideRoute({ payerCreditLevel: 'unknown', carrierWantsQuickPay: true, floatCapacityAvailable: false }).route).toBe('DECLINE');
  });

  it('declines on weak payer credit regardless of other inputs', () => {
    expect(decideRoute({ payerCreditLevel: 'weak', carrierWantsQuickPay: false, floatCapacityAvailable: true }).route).toBe('DECLINE');
    expect(decideRoute({ payerCreditLevel: 'weak', carrierWantsQuickPay: true, floatCapacityAvailable: false }).route).toBe('DECLINE');
  });

  it('routes strong-credit, net-30 carrier to T1', () => {
    expect(decideRoute({ payerCreditLevel: 'strong', carrierWantsQuickPay: false, floatCapacityAvailable: true }).route).toBe('T1');
    expect(decideRoute({ payerCreditLevel: 'strong', carrierWantsQuickPay: false, floatCapacityAvailable: false }).route).toBe('T1');
  });

  it('routes strong-credit, fast-pay carrier with float slack to T2', () => {
    expect(decideRoute({ payerCreditLevel: 'strong', carrierWantsQuickPay: true, floatCapacityAvailable: true }).route).toBe('T2');
  });

  it('routes strong-credit, fast-pay carrier at float capacity to T3', () => {
    expect(decideRoute({ payerCreditLevel: 'strong', carrierWantsQuickPay: true, floatCapacityAvailable: false }).route).toBe('T3');
  });

  it('treats acceptable credit the same as strong — the routing function only branches on weak/unknown, matching the spec code verbatim', () => {
    expect(decideRoute({ payerCreditLevel: 'acceptable', carrierWantsQuickPay: false, floatCapacityAvailable: true }).route).toBe('T1');
    expect(decideRoute({ payerCreditLevel: 'acceptable', carrierWantsQuickPay: true, floatCapacityAvailable: true }).route).toBe('T2');
    expect(decideRoute({ payerCreditLevel: 'acceptable', carrierWantsQuickPay: true, floatCapacityAvailable: false }).route).toBe('T3');
  });

  it('every decision includes non-empty reasoning', () => {
    const r = decideRoute({ payerCreditLevel: 'strong', carrierWantsQuickPay: false, floatCapacityAvailable: true });
    expect(r.reasoning.length).toBeGreaterThan(0);
  });
});
