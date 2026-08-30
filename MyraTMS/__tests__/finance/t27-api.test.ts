// __tests__/finance/t27-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/governance/api-helpers', () => ({
  authorizeGovernanceRequest: vi.fn(() => ({ user: { tenantId: 2, isSuperAdmin: false } })),
  resolveTenantId: vi.fn((_sp: URLSearchParams, user: any) => user.tenantId),
}));
const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { POST as postRouteDecision } from '@/app/api/finance/route-decision/route';
import { GET as getFloatExposureRoute } from '@/app/api/finance/float-exposure/route';
import { POST as postFactoringSubmit } from '@/app/api/finance/factoring/submit/route';
import { POST as postQuickpayDisburse } from '@/app/api/finance/quickpay/disburse/route';
import { POST as postKycVerify } from '@/app/api/finance/kyc/verify/route';
import { GET as getTreasuryReportRoute } from '@/app/api/finance/treasury-report/route';

describe('T-27 finance API', () => {
  beforeEach(() => queryMock.mockReset());

  it('POST route-decision rejects an invalid pipelineLoadId', async () => {
    const req = new NextRequest('http://x/api/finance/route-decision', { method: 'POST', body: JSON.stringify({}) });
    const res = await postRouteDecision(req);
    expect(res.status).toBe(400);
  });

  // route-decision's db.query sequence, in call order:
  //   0 getPayerCreditLevel
  //   1 getCarrierWantsQuickPay
  //   2 pipeline_loads.agreed_rate
  //   3 getFloatExposure -> v_float_exposure
  //   4 getFloatExposure -> tenant_policies (float cap; independent query)
  //   5 pipeline_loads.profit          <- SKIPPED on the DECLINE branch
  //   6 INSERT financing_decisions     <- index 5 on the DECLINE branch
  it('POST route-decision computes and persists a decision, tenant-scoped', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ credit_level: 'strong' }] })       // getPayerCreditLevel
      .mockResolvedValueOnce({ rows: [{ payment_preference: 'net_30' }] }) // getCarrierWantsQuickPay
      .mockResolvedValueOnce({ rows: [{ agreed_rate: '1500.00' }] })       // pipeline_loads.agreed_rate
      .mockResolvedValueOnce({ rows: [] })                                 // getFloatExposure -> v_float_exposure
      .mockResolvedValueOnce({ rows: [] })                                 // getFloatExposure -> tenant_policies
      .mockResolvedValueOnce({ rows: [{ profit: '150.00' }] })             // SELECT profit FROM pipeline_loads
      .mockResolvedValueOnce({ rows: [{ id: 9 }] });                       // INSERT financing_decisions

    const req = new NextRequest('http://x/api/finance/route-decision', { method: 'POST', body: JSON.stringify({ pipelineLoadId: 42 }) });
    const res = await postRouteDecision(req);
    const body = await res.json();
    expect(body.route).toBe('T1');
    expect(body.financingDecisionId).toBe(9);
    expect(queryMock).toHaveBeenCalledTimes(7);
    const insertCall = queryMock.mock.calls[6];
    expect(insertCall[1]).toEqual([42, 2, 'strong', 'net_30', true, 'T1', 15000, 10]);
  });

  it('POST route-decision on the DECLINE branch skips the profit lookup and persists null capital-days/yield', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ credit_level: 'weak' }] })         // getPayerCreditLevel -> forces DECLINE
      .mockResolvedValueOnce({ rows: [{ payment_preference: 'net_30' }] }) // getCarrierWantsQuickPay
      .mockResolvedValueOnce({ rows: [{ agreed_rate: '1500.00' }] })       // pipeline_loads.agreed_rate
      .mockResolvedValueOnce({ rows: [] })                                 // getFloatExposure -> v_float_exposure
      .mockResolvedValueOnce({ rows: [] })                                 // getFloatExposure -> tenant_policies
      .mockResolvedValueOnce({ rows: [{ id: 12 }] });                      // INSERT financing_decisions (no profit query)

    const req = new NextRequest('http://x/api/finance/route-decision', { method: 'POST', body: JSON.stringify({ pipelineLoadId: 42 }) });
    const res = await postRouteDecision(req);
    const body = await res.json();
    expect(body.route).toBe('DECLINE');
    expect(body.financingDecisionId).toBe(12);

    // One fewer query than the T1 path — the `SELECT profit` lookup is skipped.
    expect(queryMock).toHaveBeenCalledTimes(6);
    expect(queryMock.mock.calls.some(([sql]) => /SELECT profit/.test(sql))).toBe(false);

    const insertCall = queryMock.mock.calls[5];
    expect(insertCall[0]).toMatch(/INSERT INTO financing_decisions/);
    expect(insertCall[1]).toEqual([42, 2, 'weak', 'net_30', true, 'DECLINE', null, null]);
    // capital_days_projected and yield_projected, 0-indexed 6 and 7
    expect(insertCall[1][6]).toBeNull();
    expect(insertCall[1][7]).toBeNull();
  });

  it('GET float-exposure returns the tenant-scoped exposure', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ tenant_id: '2', current_float_usd: '1000' }] }) // v_float_exposure
      .mockResolvedValueOnce({ rows: [] });                                             // tenant_policies (no cap set)
    const req = new NextRequest('http://x/api/finance/float-exposure');
    const res = await getFloatExposureRoute(req);
    const body = await res.json();
    expect(body).toEqual({ tenantId: 2, currentFloatUsd: 1000, floatCapUsd: null });
  });

  it('POST factoring/submit records a sandbox submission and syncs invoices.factoring_status tenant-scoped', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: 5 }] })       // recordFactoringSubmission INSERT
      .mockResolvedValueOnce({ rows: [{ id: 'INV-1' }] }); // syncInvoiceFactoringStatus UPDATE
    const req = new NextRequest('http://x/api/finance/factoring/submit', { method: 'POST', body: JSON.stringify({ pipelineLoadId: 42, feePct: 5 }) });
    const res = await postFactoringSubmit(req);
    const body = await res.json();
    expect(body.environment).toBe('sandbox');
    expect(body.id).toBe(5);

    // The sync UPDATE must carry the resolved tenant id as its third param.
    const [syncSql, syncParams] = queryMock.mock.calls[1];
    expect(syncSql).toMatch(/UPDATE invoices/);
    expect(syncSql).toMatch(/tenant_id = \$3/);
    expect(syncParams).toEqual(['Submitted', 42, 2]);
  });

  it('POST quickpay/disburse rejects invalid input', async () => {
    const req = new NextRequest('http://x/api/finance/quickpay/disburse', { method: 'POST', body: JSON.stringify({ pipelineLoadId: 42 }) });
    const res = await postQuickpayDisburse(req);
    expect(res.status).toBe(400);
  });

  it('POST quickpay/disburse records a sandbox disbursement', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 3 }] });
    const req = new NextRequest('http://x/api/finance/quickpay/disburse', {
      method: 'POST',
      body: JSON.stringify({ pipelineLoadId: 42, carrierRegistryId: 7, amount: 1000, discountPct: 2.5 }),
    });
    const res = await postQuickpayDisburse(req);
    const body = await res.json();
    expect(body.environment).toBe('sandbox');
    expect(body.id).toBe(3);
  });

  it('POST kyc/verify rejects an invalid entityType', async () => {
    const req = new NextRequest('http://x/api/finance/kyc/verify', { method: 'POST', body: JSON.stringify({ entityType: 'shipper', entityId: 1 }) });
    const res = await postKycVerify(req);
    expect(res.status).toBe(400);
  });

  it('POST kyc/verify records a sandbox verification', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 11 }] });
    const req = new NextRequest('http://x/api/finance/kyc/verify', { method: 'POST', body: JSON.stringify({ entityType: 'carrier', entityId: 7 }) });
    const res = await postKycVerify(req);
    const body = await res.json();
    expect(body.environment).toBe('sandbox');
    expect(body.id).toBe(11);
  });

  it('GET treasury-report returns tenant-scoped aggregates', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ route_selected: 'T1', capital_days_projected: '1000', yield_projected: '5' }] });
    const req = new NextRequest('http://x/api/finance/treasury-report');
    const res = await getTreasuryReportRoute(req);
    const body = await res.json();
    expect(body.decisionCount).toBe(1);
    expect(queryMock.mock.calls[0][1]).toEqual([2]);
  });
});
