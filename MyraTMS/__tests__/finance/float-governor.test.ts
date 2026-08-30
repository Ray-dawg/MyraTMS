import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { getFloatExposure, isFloatCapacityAvailable } from '@/lib/finance/float-governor';

// getFloatExposure issues TWO independent queries via Promise.all, in this
// array order:
//   call 0 -> v_float_exposure  (current_float_usd)
//   call 1 -> tenant_policies   (float_cap_usd)
// The cap deliberately does NOT come from the view: v_float_exposure starts
// FROM financing_decisions, so it returns no rows at all for a tenant that has
// never recorded a financing decision.
describe('T-27 float governor (criterion 3)', () => {
  beforeEach(() => queryMock.mockReset());

  it('returns zero exposure and null cap when the tenant has neither financing_decisions rows nor a configured cap', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })  // v_float_exposure
      .mockResolvedValueOnce({ rows: [] }); // tenant_policies
    const exposure = await getFloatExposure(2);
    expect(exposure).toEqual({ tenantId: 2, currentFloatUsd: 0, floatCapUsd: null });
  });

  it('parses numeric strings from Neon into real numbers', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ tenant_id: '2', current_float_usd: '15000.50' }] })
      .mockResolvedValueOnce({ rows: [{ float_cap_usd: '20000' }] });
    const exposure = await getFloatExposure(2);
    expect(exposure).toEqual({ tenantId: 2, currentFloatUsd: 15000.5, floatCapUsd: 20000 });
  });

  it('still finds a configured cap on a tenant\'s very first decision, when v_float_exposure has no row yet — the cap is unenforceable otherwise', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })                            // no financing_decisions yet
      .mockResolvedValueOnce({ rows: [{ float_cap_usd: '20000' }] }); // cap is configured regardless
    const exposure = await getFloatExposure(2);
    expect(exposure).toEqual({ tenantId: 2, currentFloatUsd: 0, floatCapUsd: 20000 });
    // and that cap is now actually enforced
    expect(isFloatCapacityAvailable(exposure, 25000)).toBe(false);
  });

  it('reads the cap from tenant_policies with the codebase-wide active-version convention, independent of financing_decisions', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ float_cap_usd: '20000' }] });
    await getFloatExposure(2);

    const [viewSql, viewParams] = queryMock.mock.calls[0];
    expect(viewSql).toMatch(/v_float_exposure/);
    expect(viewParams).toEqual([2]);

    const [policySql, policyParams] = queryMock.mock.calls[1];
    expect(policySql).toMatch(/FROM tenant_policies/);
    expect(policySql).not.toMatch(/financing_decisions/);
    expect(policySql).toMatch(/is_active = true/);
    expect(policySql).toMatch(/ORDER BY version DESC/);
    expect(policySql).toMatch(/LIMIT 1/);
    expect(policyParams).toEqual([2]);
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
