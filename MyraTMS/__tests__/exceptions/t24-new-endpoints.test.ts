// __tests__/exceptions/t24-new-endpoints.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/governance/api-helpers', () => ({
  authorizeGovernanceRequest: vi.fn(() => ({ user: { tenantId: 2, isSuperAdmin: false } })),
  resolveTenantId: vi.fn((_sp: URLSearchParams, user: any) => user.tenantId),
}));
const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { GET as getRules, POST as postRule } from '@/app/api/exceptions/classification-rules/route';
import { GET as getSlaBreaches } from '@/app/api/exceptions/sla-breaches/route';

describe('T-24 new API endpoints', () => {
  beforeEach(() => queryMock.mockReset());

  it('GET classification-rules scopes by tenant_id', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, source_module: 'carrier_risk', severity: 'medium' }] });
    const req = new NextRequest('http://x/api/exceptions/classification-rules');
    const res = await getRules(req);
    const body = await res.json();
    expect(body.rules.length).toBe(1);
    expect(queryMock.mock.calls[0][1]).toEqual([2]);
  });

  it('POST classification-rules creates a new version, not an in-place update', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ max: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 9, version: 2 }] });
    const req = new NextRequest('http://x/api/exceptions/classification-rules', {
      method: 'POST',
      body: JSON.stringify({
        sourceModule: 'carrier_risk', condition: {}, severity: 'high', slaMinutes: 60, suggestedAction: 'Escalate now.',
      }),
    });
    const res = await postRule(req);
    const body = await res.json();
    expect(body.version).toBe(2);
    expect(queryMock.mock.calls[1][0]).toContain('INSERT INTO exception_classification_rules');
  });

  it('POST classification-rules rejects a missing required field', async () => {
    const req = new NextRequest('http://x/api/exceptions/classification-rules', {
      method: 'POST',
      body: JSON.stringify({ sourceModule: 'carrier_risk' }),
    });
    const res = await postRule(req);
    expect(res.status).toBe(400);
  });

  it('GET sla-breaches returns exceptions past their sla_due_at that are still active', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'exc-1', sla_due_at: '2026-08-01', source_module: 'lifecycle_late' }] });
    const req = new NextRequest('http://x/api/exceptions/sla-breaches');
    const res = await getSlaBreaches(req);
    const body = await res.json();
    expect(body.breaches.length).toBe(1);
    expect(queryMock.mock.calls[0][0]).toContain('sla_due_at < NOW()');
  });
});
