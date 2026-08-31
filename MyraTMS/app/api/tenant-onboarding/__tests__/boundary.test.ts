import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createToken } from '@/lib/auth';
import { db } from '@/lib/pipeline/db-adapter';
import { POST as startRoute } from '../start/route';
import { PATCH as advanceRoute } from '../[sessionId]/route';
import { POST as testRoute } from '../[sessionId]/test/route';
import { POST as goLiveRoute } from '../[sessionId]/request-go-live/route';

function superAdminToken(): string {
  return createToken({
    userId: 'test-user', email: 'test@myra.dev', role: 'admin',
    firstName: 'Test', lastName: 'User', tenantId: 2, tenantIds: [2],
    isSuperAdmin: true,
  });
}

function authedRequest(url: string, init: { method: string; body?: unknown } = { method: 'GET' }): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('cookie', `auth-token=${superAdminToken()}`);
  return new NextRequest(url, {
    method: init.method,
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

describe('T-28 boundary — zero writes to shippers/carriers or Myra CRM tables', () => {
  let tenantId: number | undefined;
  let sessionId: number | undefined;

  afterEach(async () => {
    if (sessionId) await db.query(`DELETE FROM tenant_onboarding_sessions WHERE id = $1`, [sessionId]);
    if (tenantId) {
      await db.query(`DELETE FROM exceptions WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM exception_classification_rules WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenant_policies WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenant_subscriptions WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenant_config WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenant_users WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
  });

  // Extended timeout: /test invokes runDryRun -> quotePricing, whose rate
  // cascade calls the real Claude API and retries ~60s before falling back
  // to the benchmark rate for a synthetic tenant with no historical data
  // (same pre-existing, unrelated behavior documented in Task 5/6/8's tests).
  it('running the full onboarding flow makes zero writes to shippers or carriers', async () => {
    const { rows: shippersBefore } = await db.query<{ count: string }>(`SELECT COUNT(*) FROM shippers`);
    const { rows: carriersBefore } = await db.query<{ count: string }>(`SELECT COUNT(*) FROM carriers`);

    const startRes = await startRoute(authedRequest('http://localhost/api/tenant-onboarding/start', { method: 'POST' }));
    sessionId = (await startRes.json()).sessionId;

    const slug = `t28-boundary-${Date.now()}`;
    const companyRes = await advanceRoute(
      authedRequest(`http://localhost/api/tenant-onboarding/${sessionId}`, {
        method: 'PATCH',
        body: { step: 'company_created', stepData: { companyName: 'Boundary Co', slug, tenantType: 'saas_customer', freightBusinessType: 'dispatcher' } },
      }),
      { params: Promise.resolve({ sessionId: String(sessionId) }) },
    );
    tenantId = (await companyRes.json()).tenantId;

    // runDryRun -> evaluatePolicy requires an active tenant_policies row,
    // which only applyTenantTypePolicyTemplate (fired by the policy_confirmed
    // step) creates -- so the flow must pass through that step before /test.
    const policyRes = await advanceRoute(
      authedRequest(`http://localhost/api/tenant-onboarding/${sessionId}`, {
        method: 'PATCH',
        body: { step: 'policy_confirmed', stepData: { freightBusinessType: 'dispatcher' } },
      }),
      { params: Promise.resolve({ sessionId: String(sessionId) }) },
    );
    expect(policyRes.status).toBe(200);

    await testRoute(
      authedRequest(`http://localhost/api/tenant-onboarding/${sessionId}/test`, { method: 'POST' }),
      { params: Promise.resolve({ sessionId: String(sessionId) }) },
    );
    await goLiveRoute(
      authedRequest(`http://localhost/api/tenant-onboarding/${sessionId}/request-go-live`, { method: 'POST' }),
      { params: Promise.resolve({ sessionId: String(sessionId) }) },
    );

    const { rows: shippersAfter } = await db.query<{ count: string }>(`SELECT COUNT(*) FROM shippers`);
    const { rows: carriersAfter } = await db.query<{ count: string }>(`SELECT COUNT(*) FROM carriers`);
    expect(shippersAfter[0].count).toBe(shippersBefore[0].count);
    expect(carriersAfter[0].count).toBe(carriersBefore[0].count);
  }, 150000);
});
