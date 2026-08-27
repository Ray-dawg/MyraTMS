/**
 * T-21 §5 — computeSellEnvelope() is T-06's calculateNegotiationParams()
 * (lib/pipeline/cost-calculator.ts) relocated verbatim, with one signature
 * change: margin thresholds are passed in (from resolveMargin()) instead of
 * being re-derived from currency internally, so tenant overrides can flow
 * through. Variable names preserved exactly as the original for auditability
 * (T-21 §5 build plan step 2). For Myra's own tenant (no override),
 * resolveMargin() returns the identical thresholds calculateNegotiationParams()
 * would derive itself, so output is byte-identical — this is the mechanism
 * that makes the §7.1 shadow-parity bar achievable, not a coincidence.
 */

import type { MarginConfig } from './resolve-margin';

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface SellEnvelope {
  initialOffer: number;
  concessionStep1: number;
  concessionStep2: number;
  finalOffer: number;
  maxConcessions: number;
}

export function computeSellEnvelope(
  totalCost: number,
  marketRateBest: number,
  margin: MarginConfig,
): SellEnvelope {
  const minAcceptableRate = totalCost + margin.minMargin;
  const targetRate = totalCost + margin.targetMargin;

  let initialOffer = targetRate;
  if (initialOffer > marketRateBest * 1.02) {
    initialOffer = Math.min(marketRateBest * 1.02, targetRate);
  }
  initialOffer = Math.max(initialOffer, minAcceptableRate);

  const maxConcession = initialOffer - minAcceptableRate;
  const concessionStep1 = roundCurrency(initialOffer - maxConcession * 0.33);
  const concessionStep2 = roundCurrency(initialOffer - maxConcession * 0.67);
  const finalOffer = roundCurrency(minAcceptableRate);

  return {
    initialOffer: roundCurrency(initialOffer),
    concessionStep1,
    concessionStep2,
    finalOffer,
    maxConcessions: 3,
  };
}
