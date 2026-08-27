import { describe, it, expect, vi } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { profileShipper, determineSellStrategy } from '@/lib/negotiation/sell-brief';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));

describe('profileShipper', () => {
  it('returns fallback defaults when phone is null', async () => {
    const profile = await profileShipper({ shipper_phone: null, shipper_company: null, shipper_contact_name: null, shipper_email: null });
    expect(profile.previousCallCount).toBe(0);
    expect(profile.preferredLanguage).toBe('en');
    expect(profile.isRepeat).toBe(false);
  });

  it('derives isRepeat from shipper_preferences.total_bookings > 0', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [{ preferred_language: 'fr', preferred_currency: 'CAD', total_calls_received: 3, total_bookings: 2, avg_agreed_rate: '2000', last_objection_type: 'rate_too_high' }] })
      .mockResolvedValueOnce({ rows: [] });
    const profile = await profileShipper({ shipper_phone: '+17055551234', shipper_company: 'Acme', shipper_contact_name: 'Jo Smith', shipper_email: null });
    expect(profile.isRepeat).toBe(true);
    expect(profile.preferredLanguage).toBe('fr');
    expect(profile.companyName).toBe('Acme');
  });
});

describe('determineSellStrategy', () => {
  it('picks the aggressive reasoning template for approach=aggressive', () => {
    const negotiation = { initialOffer: 3000, concessionStep1: 2800, concessionStep2: 2600, finalOffer: 2400, maxConcessions: 3 };
    const strategy = determineSellStrategy('aggressive', negotiation, 2000, 'CAD', {
      pickup_date: new Date(Date.now() + 72 * 3600_000), origin_country: 'CA', destination_country: 'CA',
      origin_city: 'Toronto', destination_city: 'Montreal',
    } as any);
    expect(strategy.approach).toBe('aggressive');
    expect(strategy.reasoning).toContain('Strong margin');
  });
});
