import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { profileCarrier } from '@/lib/negotiation/profile-carrier';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('profileCarrier', () => {
  it('returns myraCarrierScore: null when the score row has NULL score (no crash, no misleading default)', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [{ id: 'CAR-1', company: 'Acme Trucking', contact_name: 'Jo', contact_phone: '+15551234567', contact_email: null, mc_number: 'MC123' }] })
      .mockResolvedValueOnce({ rows: [{ score: null }] })
      .mockResolvedValueOnce({ rows: [] });

    const profile = await profileCarrier(2, 42);
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

    const profile = await profileCarrier(2, 7);
    expect(profile.myraCarrierScore).toBe(78.5);
    expect(profile.previousOutcomes.length).toBe(2);
    expect(profile.isRepeat).toBe(true);
  });

  it('passes tenantId as the second bind parameter to the carriers query (tenant-isolation fix)', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [{ id: 'CAR-3', company: 'Gamma Logistics', contact_name: 'Lee', contact_phone: '+15550001111', contact_email: null, mc_number: 'MC789' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await profileCarrier(2, 99);

    const carriersCall = (db.query as any).mock.calls.find((c: any[]) => String(c[0]).includes('FROM carriers'));
    expect(carriersCall[0]).toMatch(/tenant_id\s*=\s*\$2/);
    expect(carriersCall[1]).toEqual([99, 2]);
  });

  it('throws when no carrier row is found for the given tenant, rather than returning a null-filled profile', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [] });

    await expect(profileCarrier(2, 12345)).rejects.toThrow(/No carrier found/);
    // Only the carriers query should run -- the function must bail out
    // before querying scores/outcomes or letting a caller reach checkDnc('').
    expect((db.query as any).mock.calls.length).toBe(1);
  });
});
