import { describe, it, expect } from 'vitest';
import { determineBuyStrategy } from '@/lib/negotiation/buy-brief';

describe('determineBuyStrategy', () => {
  it('recommends standard approach with a healthy ceiling-to-opening spread', () => {
    const strategy = determineBuyStrategy(
      { ceiling: 2130, target: 1930, openingOffer: 1834.5, currency: 'CAD' },
      null,
      { pickup_date: new Date(Date.now() + 72 * 3600_000), origin_country: 'CA', destination_country: 'CA', origin_city: 'Toronto', destination_city: 'Montreal' } as any,
    );
    expect(strategy.approach).toBe('standard');
    expect(strategy.keyTalkingPoints.length).toBeGreaterThan(0);
    expect(strategy.keyTalkingPoints.some((p) => p.includes('already sold to the shipper'))).toBe(true);
    expect(strategy.keyTalkingPoints.some((p) => p.includes('Toronto') && p.includes('Montreal'))).toBe(true);
  });

  it('recommends walk approach when the concession band is thin (opening near ceiling)', () => {
    const strategy = determineBuyStrategy(
      { ceiling: 1000, target: 990, openingOffer: 985, currency: 'CAD' },
      null,
      { pickup_date: new Date(Date.now() + 72 * 3600_000), origin_country: 'CA', destination_country: 'CA', origin_city: 'Toronto', destination_city: 'Montreal' } as any,
    );
    expect(strategy.approach).toBe('walk');
    expect(strategy.keyTalkingPoints.some((p) => p.includes('already sold to the shipper'))).toBe(true);
  });

  it('recommends aggressive approach when the concession band is wide (opening far below ceiling)', () => {
    const strategy = determineBuyStrategy(
      { ceiling: 2000, target: 1800, openingOffer: 500, currency: 'CAD' },
      null,
      { pickup_date: new Date(Date.now() + 72 * 3600_000), origin_country: 'CA', destination_country: 'CA', origin_city: 'Vancouver', destination_city: 'Calgary' } as any,
    );
    expect(strategy.approach).toBe('aggressive');
    expect(strategy.reasoning.includes('anchor low')).toBe(true);
  });

  it('mentions the Myra Carrier Score in talking points when one exists', () => {
    const strategy = determineBuyStrategy(
      { ceiling: 2130, target: 1930, openingOffer: 1834.5, currency: 'CAD' },
      82.5,
      { pickup_date: new Date(Date.now() + 72 * 3600_000), origin_country: 'CA', destination_country: 'CA', origin_city: 'Toronto', destination_city: 'Montreal' } as any,
    );
    expect(strategy.keyTalkingPoints.some((p) => p.includes('82.5'))).toBe(true);
    expect(strategy.keyTalkingPoints.some((p) => p.includes('Myra Carrier Score'))).toBe(true);
  });

  it('omits urgency factor when pickup is far in the future (>=48 hours)', () => {
    const futurePickup = new Date(Date.now() + 96 * 3600_000); // 96 hours away
    const strategy = determineBuyStrategy(
      { ceiling: 2130, target: 1930, openingOffer: 1834.5, currency: 'CAD' },
      null,
      { pickup_date: futurePickup, origin_country: 'CA', destination_country: 'CA', origin_city: 'Toronto', destination_city: 'Montreal' } as any,
    );
    expect(strategy.keyTalkingPoints.some((p) => p.includes('Pickup in'))).toBe(false);
  });

  it('includes urgency factor when pickup is within 48 hours', () => {
    const soonPickup = new Date(Date.now() + 24 * 3600_000); // 24 hours away
    const strategy = determineBuyStrategy(
      { ceiling: 2130, target: 1930, openingOffer: 1834.5, currency: 'CAD' },
      null,
      { pickup_date: soonPickup, origin_country: 'CA', destination_country: 'CA', origin_city: 'Toronto', destination_city: 'Montreal' } as any,
    );
    expect(strategy.keyTalkingPoints.some((p) => p.includes('Pickup in'))).toBe(true);
    expect(strategy.keyTalkingPoints.some((p) => p.includes('limited carrier options'))).toBe(true);
  });

  it('includes cross-border urgency factor when applicable', () => {
    const strategy = determineBuyStrategy(
      { ceiling: 2130, target: 1930, openingOffer: 1834.5, currency: 'CAD' },
      null,
      { pickup_date: new Date(Date.now() + 72 * 3600_000), origin_country: 'CA', destination_country: 'US', origin_city: 'Toronto', destination_city: 'Detroit' } as any,
    );
    expect(strategy.keyTalkingPoints.some((p) => p.includes('Cross-border'))).toBe(true);
  });
});
