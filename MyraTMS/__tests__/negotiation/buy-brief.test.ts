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
  });

  it('recommends walk approach when the concession band is thin (opening near ceiling)', () => {
    const strategy = determineBuyStrategy(
      { ceiling: 1000, target: 990, openingOffer: 985, currency: 'CAD' },
      null,
      { pickup_date: new Date(Date.now() + 72 * 3600_000), origin_country: 'CA', destination_country: 'CA', origin_city: 'Toronto', destination_city: 'Montreal' } as any,
    );
    expect(strategy.approach).toBe('walk');
  });

  it('mentions the Myra Carrier Score in talking points when one exists', () => {
    const strategy = determineBuyStrategy(
      { ceiling: 2130, target: 1930, openingOffer: 1834.5, currency: 'CAD' },
      82.5,
      { pickup_date: new Date(Date.now() + 72 * 3600_000), origin_country: 'CA', destination_country: 'CA', origin_city: 'Toronto', destination_city: 'Montreal' } as any,
    );
    expect(strategy.keyTalkingPoints.some((p) => p.includes('82.5'))).toBe(true);
  });
});
