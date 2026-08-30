import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { getTreasuryReport } from '@/lib/finance/treasury-report';

describe('T-27 treasury report (criterion 6 — placeholder formula, OPEN)', () => {
  beforeEach(() => queryMock.mockReset());

  it('aggregates real financing_decisions rows, not placeholder counts', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { route_selected: 'T1', capital_days_projected: '10000', yield_projected: '12.0' },
        { route_selected: 'T1', capital_days_projected: '5000', yield_projected: '10.0' },
        { route_selected: 'DECLINE', capital_days_projected: null, yield_projected: null },
      ],
    });
    const report = await getTreasuryReport(2);
    expect(report.decisionCount).toBe(3);
    expect(report.totalCapitalDaysProjected).toBe(15000);
    expect(report.averageYieldProjected).toBeCloseTo(11, 5);
    expect(report.routeCounts).toEqual({ T1: 2, DECLINE: 1 });
    expect(queryMock.mock.calls[0][1]).toEqual([2]);
  });

  it('never claims a match to Pilot 1\'s real numbers in its note field', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const report = await getTreasuryReport(2);
    expect(report.note).toMatch(/not verified/i);
    expect(report.decisionCount).toBe(0);
    expect(report.averageYieldProjected).toBeNull();
  });
});
