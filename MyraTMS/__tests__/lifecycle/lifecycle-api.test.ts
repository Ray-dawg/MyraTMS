// __tests__/lifecycle/lifecycle-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/governance/api-helpers', () => ({
  authorizeGovernanceRequest: vi.fn(() => ({ user: { tenantId: 2, isSuperAdmin: false } })),
  resolveTenantId: vi.fn((_sp: URLSearchParams, user: any) => user.tenantId),
}));

const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { GET as getTimeline } from '@/app/api/lifecycle/load/[pipelineLoadId]/route';
import { GET as getLate } from '@/app/api/lifecycle/late/route';
import { GET as getGapReport } from '@/app/api/lifecycle/acceptance-gap-report/route';

describe('lifecycle read API', () => {
  beforeEach(() => queryMock.mockReset());

  it('GET /lifecycle/load/:id returns the ordered event timeline', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ event_type: 'load.carrier_assigned', occurred_at: '2026-08-01' }] });
    const req = new NextRequest('http://x/api/lifecycle/load/42');
    const res = await getTimeline(req, { params: Promise.resolve({ pipelineLoadId: '42' }) });
    const body = await res.json();
    expect(body.events.length).toBe(1);
    expect(queryMock.mock.calls[0][0]).toContain('ORDER BY occurred_at');
  });

  it('GET /lifecycle/load/:id rejects a non-numeric id', async () => {
    const req = new NextRequest('http://x/api/lifecycle/load/abc');
    const res = await getTimeline(req, { params: Promise.resolve({ pipelineLoadId: 'abc' }) });
    expect(res.status).toBe(400);
  });

  it('GET /lifecycle/late returns only rows with a non-null late_status', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ pipeline_load_id: 1, late_status: 'pickup_late' }] });
    const req = new NextRequest('http://x/api/lifecycle/late');
    const res = await getLate(req);
    const body = await res.json();
    expect(body.lateLoads.length).toBe(1);
    expect(queryMock.mock.calls[0][0]).toContain('late_status IS NOT NULL');
  });

  it('GET /lifecycle/acceptance-gap-report returns the aggregate shape', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ total: '10', confirmed: '3' }] })
      .mockResolvedValueOnce({ rows: [{ delivered: '5', reassigned: '1', pickup_late: '2', unconfirmed_total: '7' }] });
    const req = new NextRequest('http://x/api/lifecycle/acceptance-gap-report?since=30');
    const res = await getGapReport(req);
    const body = await res.json();
    expect(body.total).toBe(10);
    expect(body.confirmed).toBe(3);
    expect(body.unconfirmedBreakdown.delivered).toBe(5);
  });
});
