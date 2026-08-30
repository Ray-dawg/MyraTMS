import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { getPayerCreditLevel, getCarrierWantsQuickPay } from '@/lib/finance/credit-lookup';

describe('T-27 credit/preference lookups', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns the most recent payer credit_level for the load\'s payer', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ credit_level: 'strong' }] });
    const level = await getPayerCreditLevel(42);
    expect(level).toBe('strong');
    expect(queryMock.mock.calls[0][1]).toEqual([42]);
  });

  it('defaults to unknown when no assessment exists — conservative default, matches decideRoute\'s decline branch', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await getPayerCreditLevel(42)).toBe('unknown');
  });

  it('returns true when carrier_registry.payment_preference is quick_pay', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ payment_preference: 'quick_pay' }] });
    expect(await getCarrierWantsQuickPay(42)).toBe(true);
  });

  it('returns false when payment_preference is net_30, null, or no carrier is matched', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ payment_preference: 'net_30' }] });
    expect(await getCarrierWantsQuickPay(42)).toBe(false);
    queryMock.mockResolvedValueOnce({ rows: [{ payment_preference: null }] });
    expect(await getCarrierWantsQuickPay(42)).toBe(false);
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await getCarrierWantsQuickPay(42)).toBe(false);
  });
});
