import { describe, it, expect } from 'vitest';
import { computeSellEnvelope } from '../sell-envelope';
import { calculateNegotiationParams, getMarginThresholds } from '@/lib/pipeline/cost-calculator';
import type { MarginConfig } from '../resolve-margin';

function myraMarginFor(currency: 'CAD' | 'USD'): MarginConfig {
  const t = getMarginThresholds(currency);
  return { minMargin: t.floor, targetMargin: t.target, stretchMargin: t.stretch };
}

describe('computeSellEnvelope — T-21 §7.1 shadow parity', () => {
  const cases: Array<{ cost: number; currency: 'CAD' | 'USD'; marketBest: number }> = [
    { cost: 1200, currency: 'CAD', marketBest: 2000 },
    { cost: 800, currency: 'USD', marketBest: 900 },
    { cost: 2500, currency: 'CAD', marketBest: 10000 },
    { cost: 0, currency: 'USD', marketBest: 100 },
  ];

  it.each(cases)('matches calculateNegotiationParams() exactly for %j', ({ cost, currency, marketBest }) => {
    const old = calculateNegotiationParams(cost, currency, marketBest);
    const margin = myraMarginFor(currency);
    const fresh = computeSellEnvelope(cost, marketBest, margin);

    expect(fresh.initialOffer).toBe(old.initialOffer);
    expect(fresh.concessionStep1).toBe(old.concessionStep1);
    expect(fresh.concessionStep2).toBe(old.concessionStep2);
    expect(fresh.finalOffer).toBe(old.finalOffer);
  });

  it('a tenant override margin produces a visibly different envelope than the Myra default', () => {
    const cost = 1200;
    const myraMargin = myraMarginFor('CAD');
    const overrideMargin: MarginConfig = { minMargin: 100, targetMargin: 200, stretchMargin: 300 };

    const myraEnvelope = computeSellEnvelope(cost, 5000, myraMargin);
    const overrideEnvelope = computeSellEnvelope(cost, 5000, overrideMargin);

    expect(overrideEnvelope.finalOffer).not.toBe(myraEnvelope.finalOffer);
    expect(overrideEnvelope.finalOffer).toBe(cost + overrideMargin.minMargin);
  });
});
