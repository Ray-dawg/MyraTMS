//
// New — mirrors determineSellStrategy()'s shape and reasoning-by-approach
// pattern (lib/negotiation/sell-brief.ts), inverted for the buy direction:
// Myra wants to pay LESS, so "aggressive" here means pushing hard toward
// the opening offer rather than conceding quickly toward the ceiling.

import type { NegotiationBriefStrategy } from './types';

interface BuyLoadFields {
  pickup_date: Date | string;
  origin_country: string;
  destination_country: string;
  origin_city: string;
  destination_city: string;
}

export function determineBuyStrategy(
  envelope: { ceiling: number; target: number; openingOffer: number; currency: 'CAD' | 'USD' },
  myraCarrierScore: number | null,
  load: BuyLoadFields,
): NegotiationBriefStrategy {
  // Concession band: how much room exists between opening and ceiling,
  // relative to the ceiling itself. A thin band means little room to
  // negotiate before hitting the number Myra can't exceed — walk rather
  // than push, same "protect the margin" framing dispatch_one_v1.json's
  // global prompt states (per T-22 §3.1).
  const band = envelope.ceiling > 0 ? (envelope.ceiling - envelope.openingOffer) / envelope.ceiling : 0;
  const approach: NegotiationBriefStrategy['approach'] = band < 0.05 ? 'walk' : band > 0.15 ? 'aggressive' : 'standard';

  const reasoningMap: Record<typeof approach, string> = {
    aggressive: `Wide concession band ($${(envelope.ceiling - envelope.openingOffer).toFixed(2)} ${envelope.currency} to ceiling) — anchor low, concede slowly.`,
    standard: `Healthy concession band at standard rate. Walk the ladder methodically toward the ceiling.`,
    walk: `Thin concession band — be prepared to decline gracefully if the carrier won't move toward the opening offer.`,
  };

  const pickup = load.pickup_date instanceof Date ? load.pickup_date : new Date(load.pickup_date);
  const hoursUntil = (pickup.getTime() - Date.now()) / 3600_000;
  const urgencyFactors: string[] = [];
  if (hoursUntil < 48) urgencyFactors.push(`Pickup in ${Math.round(hoursUntil)} hours — limited carrier options`);
  if (load.origin_country !== load.destination_country) urgencyFactors.push('Cross-border — fewer authorized carriers available');

  const talkingPoints = [
    'this load is already sold to the shipper — the job is securing execution capacity at a rate that protects the margin already agreed',
    ...urgencyFactors,
    `Mention the ${load.origin_city} -> ${load.destination_city} corridor and any recurring volume`,
  ];
  if (myraCarrierScore != null) {
    talkingPoints.push(`Carrier's Myra Carrier Score: ${myraCarrierScore} — factor into how much concession room to extend`);
  }

  return { approach, reasoning: reasoningMap[approach], keyTalkingPoints: talkingPoints };
}
