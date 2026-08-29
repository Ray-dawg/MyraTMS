// __tests__/risk/t25-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/governance/api-helpers', () => ({
  authorizeGovernanceRequest: vi.fn(() => ({ user: { tenantId: 2, isSuperAdmin: false, userId: 'u1', firstName: 'Test', lastName: 'User' } })),
  resolveTenantId: vi.fn((_sp: URLSearchParams, user: any) => user.tenantId),
}));
const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { GET as getCarrierRisk } from '@/app/api/risk/carrier/[carrierRegistryId]/route';
import { POST as postAssess } from '@/app/api/risk/payer/[payerRegistryId]/assess/route';
import { GET as getConcentration } from '@/app/api/risk/payer/[payerRegistryId]/concentration/route';
import { GET as getHalts } from '@/app/api/risk/halts/route';
import { POST as postResume } from '@/app/api/risk/halts/[id]/resume/route';
import { GET as getCrossCheck } from '@/app/api/risk/double-broker-crosscheck/route';

describe('T-25 risk API', () => {
  beforeEach(() => queryMock.mockReset());

  it('GET carrier risk returns signals with computed severity', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, signal_type: 'insurance_lapsed', severity: 'medium', detected_at: '2026-08-01' }] });
    const req = new NextRequest('http://x/api/risk/carrier/9');
    const res = await getCarrierRisk(req, { params: Promise.resolve({ carrierRegistryId: '9' }) });
    const body = await res.json();
    expect(body.signals[0].computedSeverity).toBe('high');
  });

  it('POST payer assess requires assessedBy and creditLevel', async () => {
    const req = new NextRequest('http://x/api/risk/payer/1/assess', { method: 'POST', body: JSON.stringify({}) });
    const res = await postAssess(req, { params: Promise.resolve({ payerRegistryId: '1' }) });
    expect(res.status).toBe(400);
  });

  it('POST payer assess inserts a new assessment row on valid input', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 55 }] });
    const req = new NextRequest('http://x/api/risk/payer/1/assess', {
      method: 'POST',
      body: JSON.stringify({ creditLevel: 'weak', assessmentSource: 'manual', assessmentNotes: 'slow to pay' }),
    });
    const res = await postAssess(req, { params: Promise.resolve({ payerRegistryId: '1' }) });
    expect(res.status).toBe(200);
    expect(queryMock.mock.calls[0][0]).toContain('INSERT INTO payer_credit_assessments');
  });

  it('GET concentration returns the view row for the payer', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ payer_registry_id: 1, concentration_pct: '0.4' }] }) // the view query
      .mockResolvedValueOnce({ rows: [{ concentration_cap_pct: null }] }); // getConcentrationCap()'s own query
    const req = new NextRequest('http://x/api/risk/payer/1/concentration');
    const res = await getConcentration(req, { params: Promise.resolve({ payerRegistryId: '1' }) });
    const body = await res.json();
    expect(body.concentrationPct).toBe(0.4);
    expect(body.capPct).toBe(25);
  });

  it('GET halts filters to active by default', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 1, halt_reason: 'banking_change_detected' }] });
    const req = new NextRequest('http://x/api/risk/halts');
    const res = await getHalts(req);
    const body = await res.json();
    expect(body.halts.length).toBe(1);
    expect(queryMock.mock.calls[0][0]).toContain('resumed_at IS NULL');
  });

  it('POST resume requires actor and resolutionNote', async () => {
    const req = new NextRequest('http://x/api/risk/halts/1/resume', { method: 'POST', body: JSON.stringify({}) });
    const res = await postResume(req, { params: Promise.resolve({ id: '1' }) });
    expect(res.status).toBe(400);
  });

  it('GET double-broker-crosscheck returns the report shape', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const req = new NextRequest('http://x/api/risk/double-broker-crosscheck?since=90');
    const res = await getCrossCheck(req);
    const body = await res.json();
    expect(body.flagged).toEqual([]);
  });
});
