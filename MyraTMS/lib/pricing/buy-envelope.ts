/**
 * T-21 §5 — computeBuyEnvelope(): the mirror of computeSellEnvelope() for
 * carrier-side (buy) negotiation. Initial offer starts low, concedes upward
 * to a ceiling Myra won't pay above.
 *
 * Calibration note (real blocker found before writing this, reported back
 * rather than silently worked around): the spec calibrates this against
 * `dispatch_one_v1.json`'s hardcoded BUY ENVELOPE fixture — that file does
 * not exist anywhere in this repo (verified: grepped the whole tree, only
 * this spec and T-22's spec mention it). The closest real, already-live
 * reference is calculateCarrierNegotiationParams() in
 * lib/pipeline/cost-calculator.ts (E2-03 M2, used today by the Dispatcher
 * to cap what Myra pays a carrier) — same shape (ceiling / target /
 * openingOffer, opening 5% below target, capped at the ceiling). This
 * function reuses that exact ratio/shape, re-parameterized to take
 * (totalCost, marketRateMid, margin) instead of an already-agreed shipper
 * rate — appropriate here since the Pricing Engine runs at Researcher-time,
 * before any shipper rate is agreed. rates.midRate stands in for "the
 * revenue Myra could realistically get," playing the same role
 * agreedShipperRate plays in the live Dispatcher-time calculation.
 */

import type { MarginConfig } from './resolve-margin';

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface BuyEnvelope {
  openingOffer: number;
  concessionStep1: number;
  concessionStep2: number;
  finalOffer: number; // ceiling — never pay above this
  maxConcessions: number;
}

export function computeBuyEnvelope(
  totalCost: number,
  marketRateMid: number,
  margin: MarginConfig,
): BuyEnvelope {
  const ceiling = Math.max(0, marketRateMid - margin.minMargin);
  const target = Math.max(0, Math.min(marketRateMid - margin.targetMargin, ceiling));
  // Opening offer starts 5% below target (concession room, mirrors
  // calculateCarrierNegotiationParams()'s existing ratio), never negative,
  // never above the ceiling.
  const openingOffer = Math.max(0, Math.min(target * 0.95, ceiling));

  const concessionRoom = ceiling - openingOffer;
  const concessionStep1 = roundCurrency(openingOffer + concessionRoom * 0.33);
  const concessionStep2 = roundCurrency(openingOffer + concessionRoom * 0.67);

  return {
    openingOffer: roundCurrency(openingOffer),
    concessionStep1,
    concessionStep2,
    finalOffer: roundCurrency(ceiling),
    maxConcessions: 3,
  };
}
