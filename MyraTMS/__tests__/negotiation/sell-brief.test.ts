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

  it('maps previousOutcomes from agent_calls results', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [{ preferred_language: 'en', preferred_currency: 'USD', total_calls_received: 5, total_bookings: 1, avg_agreed_rate: '1800', last_objection_type: null }] })
      .mockResolvedValueOnce({
        rows: [
          { outcome: 'booked', agreed_rate: '1900', call_initiated_at: new Date() },
          { outcome: 'declined', agreed_rate: null, call_initiated_at: new Date() },
          { outcome: 'voicemail', agreed_rate: null, call_initiated_at: new Date() },
        ]
      });
    const profile = await profileShipper({ shipper_phone: '+12125551234', shipper_company: 'TestCorp', shipper_contact_name: 'Jane Doe', shipper_email: 'jane@test.com' });
    expect(profile.previousOutcomes).toEqual(['booked', 'declined', 'voicemail']);
    expect(profile.previousCallCount).toBe(5);
  });
});

describe('determineSellStrategy', () => {
  it('picks the aggressive reasoning template for approach=aggressive', () => {
    const negotiation = { initialOffer: 3000 };
    const strategy = determineSellStrategy('aggressive', negotiation, 2000, 'CAD', {
      pickup_date: new Date(Date.now() + 72 * 3600_000), origin_country: 'CA', destination_country: 'CA',
      origin_city: 'Toronto', destination_city: 'Montreal',
    } as any);
    expect(strategy.approach).toBe('aggressive');
    expect(strategy.reasoning).toContain('Strong margin');
  });

  it('picks the standard reasoning template for approach=standard', () => {
    const negotiation = { initialOffer: 2500 };
    const strategy = determineSellStrategy('standard', negotiation, 2000, 'USD', {
      pickup_date: new Date(Date.now() + 96 * 3600_000), origin_country: 'US', destination_country: 'US',
      origin_city: 'Chicago', destination_city: 'Dallas',
    } as any);
    expect(strategy.approach).toBe('standard');
    expect(strategy.reasoning).toContain('Healthy margin');
    expect(strategy.reasoning).toContain('Walk the ladder methodically');
  });

  it('picks the walk reasoning template for approach=walk', () => {
    const negotiation = { initialOffer: 2100 };
    const strategy = determineSellStrategy('walk', negotiation, 2000, 'CAD', {
      pickup_date: new Date(Date.now() + 120 * 3600_000), origin_country: 'CA', destination_country: 'CA',
      origin_city: 'Vancouver', destination_city: 'Calgary',
    } as any);
    expect(strategy.approach).toBe('walk');
    expect(strategy.reasoning).toContain('marginal');
    expect(strategy.reasoning).toContain('decline gracefully');
  });

  it('includes urgency factor when pickup is < 48 hours away', () => {
    const negotiation = { initialOffer: 3000 };
    const hoursUntilPickup = 24;
    const pickupDate = new Date(Date.now() + hoursUntilPickup * 3600_000);
    const strategy = determineSellStrategy('standard', negotiation, 2000, 'CAD', {
      pickup_date: pickupDate, origin_country: 'CA', destination_country: 'CA',
      origin_city: 'Toronto', destination_city: 'Montreal',
    } as any);
    expect(strategy.keyTalkingPoints).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Pickup in'),
        expect.stringContaining('hours — limited capacity'),
      ])
    );
  });

  it('includes cross-border urgency factor when origin_country !== destination_country', () => {
    const negotiation = { initialOffer: 3000 };
    const strategy = determineSellStrategy('standard', negotiation, 2000, 'CAD', {
      pickup_date: new Date(Date.now() + 72 * 3600_000), origin_country: 'CA', destination_country: 'US',
      origin_city: 'Toronto', destination_city: 'Buffalo',
    } as any);
    expect(strategy.keyTalkingPoints).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Cross-border'),
        expect.stringContaining('fewer authorized carriers'),
      ])
    );
  });

  it('includes city-specific talking points', () => {
    const negotiation = { initialOffer: 3000 };
    const strategy = determineSellStrategy('aggressive', negotiation, 2000, 'CAD', {
      pickup_date: new Date(Date.now() + 96 * 3600_000), origin_country: 'CA', destination_country: 'CA',
      origin_city: 'Toronto', destination_city: 'Montreal',
    } as any);
    expect(strategy.keyTalkingPoints).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Montreal'),
        expect.stringContaining('Toronto'),
      ])
    );
  });
});
