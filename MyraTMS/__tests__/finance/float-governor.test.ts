import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { getFloatExposure, isFloatCapacityAvailable } from '@/lib/finance/float-governor';

describe('T-27 float governor (criterion 3)', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns zero exposure and null cap when the tenant has no financing_decisions rows yet', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const exposure = await getFloatExposure(2);
    expect(exposure).toEqual({ tenantId: 2, currentFloatUsd: 0, floatCapUsd: null });
  });

  it('parses numeric strings from Neon into real numbers', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ tenant_id: '2', current_float_usd: '15000.50', float_cap_usd: '20000' }] });
    const exposure = await getFloatExposure(2);
    expect(exposure).toEqual({ tenantId: 2, currentFloatUsd: 15000.5, floatCapUsd: 20000 });
  });

  it('treats a null float cap as unlimited — Myra has not set a real cap yet (spec §4.1)', () => {
    expect(isFloatCapacityAvailable({ tenantId: 2, currentFloatUsd: 999999, floatCapUsd: null }, 500)).toBe(true);
  });

  it('forces capacity-unavailable once current + projected would exceed a configured cap', () => {
    expect(isFloatCapacityAvailable({ tenantId: 2, currentFloatUsd: 19800, floatCapUsd: 20000 }, 500)).toBe(false);
  });

  it('allows capacity when current + projected stays within a configured cap', () => {
    expect(isFloatCapacityAvailable({ tenantId: 2, currentFloatUsd: 10000, floatCapUsd: 20000 }, 500)).toBe(true);
  });

  it('allows capacity exactly at the cap boundary (<=, not <)', () => {
    expect(isFloatCapacityAvailable({ tenantId: 2, currentFloatUsd: 19500, floatCapUsd: 20000 }, 500)).toBe(true);
  });
});
