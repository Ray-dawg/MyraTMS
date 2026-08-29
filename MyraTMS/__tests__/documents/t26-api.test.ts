// __tests__/documents/t26-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/governance/api-helpers', () => ({
  authorizeGovernanceRequest: vi.fn(() => ({ user: { tenantId: 2, isSuperAdmin: false } })),
  resolveTenantId: vi.fn((_sp: URLSearchParams, user: any) => user.tenantId),
}));
const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { GET as getRateConStatus } from '@/app/api/documents/rate-con/[pipelineLoadId]/route';
import { GET as getMismatches } from '@/app/api/documents/terms-mismatches/route';
import { GET as getIntakeReport } from '@/app/api/documents/intake-match-report/route';

describe('T-26 documents API', () => {
  beforeEach(() => queryMock.mockReset());

  it('GET rate-con status returns both outbound and inbound events for a load', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { event_type: 'document.rate_con_sent', occurred_at: '2026-08-01' },
        { event_type: 'document.rate_con_received', occurred_at: '2026-08-02' },
      ],
    });
    const req = new NextRequest('http://x/api/documents/rate-con/42');
    const res = await getRateConStatus(req, { params: Promise.resolve({ pipelineLoadId: '42' }) });
    const body = await res.json();
    expect(body.events.length).toBe(2);
  });

  it('GET terms-mismatches defaults to mismatch status, via a parameterized query', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'DOC-1', terms_match_status: 'mismatch' }] });
    const req = new NextRequest('http://x/api/documents/terms-mismatches');
    const res = await getMismatches(req);
    const body = await res.json();
    expect(body.mismatches.length).toBe(1);
    expect(queryMock.mock.calls[0][1]).toEqual(['mismatch']);
  });

  it('GET terms-mismatches rejects an invalid status value', async () => {
    const req = new NextRequest('http://x/api/documents/terms-mismatches?status=DROP TABLE documents');
    const res = await getMismatches(req);
    expect(res.status).toBe(400);
  });

  it('GET intake-match-report reports real counts, not a placeholder', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ total: '10', matched: '3', parseable: '2' }] });
    const req = new NextRequest('http://x/api/documents/intake-match-report?since=90');
    const res = await getIntakeReport(req);
    const body = await res.json();
    expect(body.total).toBe(10);
    expect(body.matchRatePct).toBe(30);
    expect(body.extractionAccuracyPct).toBeCloseTo(66.67, 1);
  });
});
