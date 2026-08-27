import { describe, it, expect, vi } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { profileCarrier } from '@/lib/negotiation/profile-carrier';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));

describe('profileCarrier', () => {
  it('returns myraCarrierScore: null when the score row has NULL score (no crash, no misleading default)', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [{ id: 'CAR-1', company: 'Acme Trucking', contact_name: 'Jo', contact_phone: '+15551234567', contact_email: null, mc_number: 'MC123' }] })
      .mockResolvedValueOnce({ rows: [{ score: null }] })
      .mockResolvedValueOnce({ rows: [] });

    const profile = await profileCarrier(42);
    expect(profile.myraCarrierScore).toBeNull();
    expect(profile.counterpartyType).toBe('carrier');
    expect(profile.mcNumber).toBe('MC123');
    expect(profile.isRepeat).toBe(false);
  });

  it('returns myraCarrierScore as a number when a real score exists', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [{ id: 'CAR-2', company: 'Beta Freight', contact_name: 'Sam', contact_phone: '+15559876543', contact_email: null, mc_number: 'MC456' }] })
      .mockResolvedValueOnce({ rows: [{ score: '78.50' }] })
      .mockResolvedValueOnce({ rows: [{ event_type: 'completed_on_time' }, { event_type: 'accepted' }] });

    const profile = await profileCarrier(7);
    expect(profile.myraCarrierScore).toBe(78.5);
    expect(profile.previousOutcomes.length).toBe(2);
    expect(profile.isRepeat).toBe(true);
  });
});
