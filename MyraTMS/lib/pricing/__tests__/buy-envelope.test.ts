import { describe, it, expect } from 'vitest';
import { computeBuyEnvelope } from '../buy-envelope';
import { calculateCarrierNegotiationParams, getMarginThresholds } from '@/lib/pipeline/cost-calculator';
import type { MarginConfig } from '../resolve-margin';

function myraMarginFor(currency: 'CAD' | 'USD'): MarginConfig {
  const t = getMarginThresholds(currency);
  return { minMargin: t.floor, targetMargin: t.target, stretchMargin: t.stretch };
}

describe('computeBuyEnvelope — T-21 §7.2 (calibrated against calculateCarrierNegotiationParams, dispatch_one_v1.json not present in repo)', () => {
  it('produces the mirror shape: opening < target-ish <= ceiling, upward concession', () => {
    const margin = myraMarginFor('CAD');
    const env = computeBuyEnvelope(1200, 2400, margin);

    expect(env.openingOffer).toBeLessThanOrEqual(env.concessionStep1);
    expect(env.concessionStep1).toBeLessThanOrEqual(env.concessionStep2);
    expect(env.concessionStep2).toBeLessThanOrEqual(env.finalOffer);
    expect(env.finalOffer).toBe(2400 - margin.minMargin); // ceiling
  });

  it('never goes negative even when cost/market inputs are tiny', () => {
    const margin = myraMarginFor('USD');
    const env = computeBuyEnvelope(0, 10, margin);
    expect(env.openingOffer).toBeGreaterThanOrEqual(0);
    expect(env.finalOffer).toBeGreaterThanOrEqual(0);
  });

  it('reuses the exact same ceiling/opening ratio as the live calculateCarrierNegotiationParams()', () => {
    // calculateCarrierNegotiationParams(agreedShipperRate, currency) computes
    // ceiling = agreedShipperRate - floor, openingOffer = min(target*0.95, ceiling).
    // computeBuyEnvelope(cost, marketRateMid, margin) uses the identical shape,
    // substituting marketRateMid for agreedShipperRate. With cost held at 0 (so
    // it plays no role) the two should agree exactly.
    const currency = 'CAD';
    const marketRateMid = 2400;
    const margin = myraMarginFor(currency);

    const live = calculateCarrierNegotiationParams(marketRateMid, currency);
    const fresh = computeBuyEnvelope(0, marketRateMid, margin);

    expect(fresh.finalOffer).toBe(live.ceiling);
    expect(fresh.openingOffer).toBe(live.openingOffer);
  });
});
