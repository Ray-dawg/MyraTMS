/**
 * E2-03 M2 (§6.5): the carrier-side counterpart to cost-calculator.ts's
 * existing calculateNegotiationParams() (shipper side). Direction is
 * inverted — the shipper function computes a floor Myra won't go below when
 * SELLING; this one computes a ceiling Myra won't go above when PAYING a
 * carrier. Per the design doc, this uses the same flat-dollar
 * getMarginThresholds() table every other margin calculation in this
 * codebase already uses — not a raw percentage (PRD §6.5's own text
 * inconsistently names the parameter minMarginPct but the formula it gives
 * uses minMarginFloor; resolved toward the existing flat-dollar pattern).
 */

import { describe, it, expect } from 'vitest';
import { calculateCarrierNegotiationParams } from '@/lib/pipeline/cost-calculator';

describe('calculateCarrierNegotiationParams', () => {
  it('CAD: ceiling is agreedShipperRate minus the CAD floor margin (270)', () => {
    const result = calculateCarrierNegotiationParams(2400, 'CAD');
    expect(result.ceiling).toBe(2400 - 270);
    expect(result.currency).toBe('CAD');
  });

  it('USD: ceiling is agreedShipperRate minus the USD floor margin (200)', () => {
    const result = calculateCarrierNegotiationParams(1800, 'USD');
    expect(result.ceiling).toBe(1800 - 200);
    expect(result.currency).toBe('USD');
  });

  it('target sits below the ceiling (Myra wants to pay less, not more)', () => {
    const result = calculateCarrierNegotiationParams(2400, 'CAD');
    expect(result.target).toBeLessThan(result.ceiling);
  });

  it('openingOffer sits below target (concession room to negotiate upward toward, never past, the ceiling)', () => {
    const result = calculateCarrierNegotiationParams(2400, 'CAD');
    expect(result.openingOffer).toBeLessThan(result.target);
    expect(result.openingOffer).toBeLessThanOrEqual(result.ceiling);
  });

  it('never produces a negative ceiling on a thin shipper rate (degenerate load) — floors at 0', () => {
    const result = calculateCarrierNegotiationParams(100, 'CAD'); // 100 - 270 would be negative
    expect(result.ceiling).toBeGreaterThanOrEqual(0);
    expect(result.target).toBeGreaterThanOrEqual(0);
    expect(result.openingOffer).toBeGreaterThanOrEqual(0);
  });

  it('rounds all three returned figures to 2 decimal places, given a non-round agreedShipperRate (whole-branch review finding 2)', () => {
    // 2400.33 - 270 (floor) = 2130.33; 2400.33 - 470 (target margin) =
    // 1930.33; openingOffer = min(1930.33 * 0.95, 2130.33) = 1833.8135,
    // which must come back rounded to 1833.81, not the raw fractional-cent
    // value — this is what the sibling calculateNegotiationParams() already
    // guarantees via roundCurrency() and this function previously did not.
    const result = calculateCarrierNegotiationParams(2400.33, 'CAD');
    expect(result.ceiling).toBeCloseTo(2130.33, 2);
    expect(result.target).toBeCloseTo(1930.33, 2);
    expect(result.openingOffer).toBeCloseTo(1833.81, 2);

    // No field should carry more than 2 decimal digits of precision.
    for (const value of [result.ceiling, result.target, result.openingOffer]) {
      expect(Math.round(value * 100) / 100).toBe(value);
    }
  });
});
