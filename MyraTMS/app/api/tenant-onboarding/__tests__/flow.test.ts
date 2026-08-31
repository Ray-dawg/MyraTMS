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

describe('tenant-onboarding API — full flow (fixture: broker)', () => {
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
  // (same pre-existing, unrelated behavior documented in Task 5/6's tests).
  it('walks a fixture broker tenant from sign_up to go_live_requested', async () => {
    const startRes = await startRoute(authedRequest('http://localhost/api/tenant-onboarding/start', { method: 'POST' }));
    const startBody = await startRes.json();
    sessionId = startBody.sessionId;

    const slug = `t28-e2e-broker-${Date.now()}`;
    const companyRes = await advanceRoute(
      authedRequest(`http://localhost/api/tenant-onboarding/${sessionId}`, {
        method: 'PATCH',
        body: {
          step: 'company_created',
          stepData: { companyName: 'E2E Broker Co', slug, tenantType: 'saas_customer', freightBusinessType: 'broker' },
        },
      }),
      { params: Promise.resolve({ sessionId: String(sessionId) }) },
    );
    const companyBody = await companyRes.json();
    tenantId = companyBody.tenantId;
    expect(tenantId).toBeTypeOf('number');

    // runDryRun -> evaluatePolicy requires an active tenant_policies row,
    // which only applyTenantTypePolicyTemplate (fired by the policy_confirmed
    // step) creates -- so the flow must pass through that step before /test.
    const policyRes = await advanceRoute(
      authedRequest(`http://localhost/api/tenant-onboarding/${sessionId}`, {
        method: 'PATCH',
        body: { step: 'policy_confirmed', stepData: { freightBusinessType: 'broker' } },
      }),
      { params: Promise.resolve({ sessionId: String(sessionId) }) },
    );
    expect(policyRes.status).toBe(200);

    const testRes = await testRoute(
      authedRequest(`http://localhost/api/tenant-onboarding/${sessionId}/test`, { method: 'POST' }),
      { params: Promise.resolve({ sessionId: String(sessionId) }) },
    );
    expect(testRes.status).toBe(200);

    const goLiveRes = await goLiveRoute(
      authedRequest(`http://localhost/api/tenant-onboarding/${sessionId}/request-go-live`, { method: 'POST' }),
      { params: Promise.resolve({ sessionId: String(sessionId) }) },
    );
    expect(goLiveRes.status).toBe(200);

    const { rows } = await db.query<{ current_step: string }>(
      `SELECT current_step FROM tenant_onboarding_sessions WHERE id = $1`, [sessionId],
    );
    expect(rows[0].current_step).toBe('go_live_requested');
  }, 150000);
});
