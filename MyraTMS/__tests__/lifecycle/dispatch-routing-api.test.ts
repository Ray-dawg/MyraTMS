// __tests__/lifecycle/dispatch-routing-api.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const authMock = vi.fn(() => ({ user: { tenantId: 2, isSuperAdmin: false } }));
vi.mock('@/lib/governance/api-helpers', () => ({
  authorizeGovernanceRequest: (...args: any[]) => authMock(...args),
}));
vi.mock('@/lib/dispatch/routing', () => ({
  resolveDispatchRouting: vi.fn(async () => ({ mode: 'myra_managed', notifyContact: null, source: 'tenant_policy_default' })),
  setDispatchRoutingOverride: vi.fn(async () => undefined),
}));

import { GET, POST } from '@/app/api/dispatch/routing/[tenantId]/route';
import { setDispatchRoutingOverride } from '@/lib/dispatch/routing';

describe('GET/POST /api/dispatch/routing/:tenantId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockReturnValue({ user: { tenantId: 2, isSuperAdmin: false } });
  });

  it('GET resolves routing for the given tenant', async () => {
    const req = new NextRequest('http://x/api/dispatch/routing/2');
    const res = await GET(req, { params: Promise.resolve({ tenantId: '2' }) });
    const body = await res.json();
    expect(body.mode).toBe('myra_managed');
  });

  it('POST sets an override with a valid body', async () => {
    const req = new NextRequest('http://x/api/dispatch/routing/2', {
      method: 'POST',
      body: JSON.stringify({ mode: 'in_house_notify', notifyContact: 'dispatch@carrier.test' }),
    });
    const res = await POST(req, { params: Promise.resolve({ tenantId: '2' }) });
    expect(res.status).toBe(200);
    expect(setDispatchRoutingOverride).toHaveBeenCalledWith(2, 'in_house_notify', 'dispatch@carrier.test');
  });

  it('POST rejects an invalid mode', async () => {
    const req = new NextRequest('http://x/api/dispatch/routing/2', {
      method: 'POST',
      body: JSON.stringify({ mode: 'bogus' }),
    });
    const res = await POST(req, { params: Promise.resolve({ tenantId: '2' }) });
    expect(res.status).toBe(400);
  });

  it('GET rejects a non-super-admin reading another tenant (IDOR)', async () => {
    const req = new NextRequest('http://x/api/dispatch/routing/99');
    const res = await GET(req, { params: Promise.resolve({ tenantId: '99' }) });
    expect(res.status).toBe(403);
  });

  it('POST rejects a non-super-admin overriding another tenant (IDOR)', async () => {
    const req = new NextRequest('http://x/api/dispatch/routing/99', {
      method: 'POST',
      body: JSON.stringify({ mode: 'in_house_notify', notifyContact: 'attacker@evil.test' }),
    });
    const res = await POST(req, { params: Promise.resolve({ tenantId: '99' }) });
    expect(res.status).toBe(403);
    expect(setDispatchRoutingOverride).not.toHaveBeenCalled();
  });

  it('a super-admin may read/override another tenant', async () => {
    authMock.mockReturnValue({ user: { tenantId: 2, isSuperAdmin: true } });
    const req = new NextRequest('http://x/api/dispatch/routing/99');
    const res = await GET(req, { params: Promise.resolve({ tenantId: '99' }) });
    expect(res.status).toBe(200);
  });
});
