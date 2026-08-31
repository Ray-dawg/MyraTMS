/**
 * T-28 Task 7 — approval flips tenant status via the exceptions resolve action.
 *
 * Auth pattern reused from app/api/admin/tenants/__tests__/route.test.ts
 * (itself reused from __tests__/governance/api.test.ts): a real createToken()
 * + 'auth-token' cookie on a real NextRequest, no mocking of getCurrentUser/
 * requireTenantContext. Unlike that admin/tenants test (which is gated by
 * requireSuperAdmin and can hardcode tenantId: 2), this route is gated by
 * requireTenantContext — per lib/auth.ts, with no x-myra-tenant-* headers on
 * the request, requireTenantContext falls back to getCurrentUser(request) and
 * reads tenantId directly off the JWT. So the token here MUST carry the
 * dynamically-provisioned tenantId, not a hardcoded one, for the exception's
 * tenant_id to match ctx.tenantId inside withTenant().
 */
import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { PATCH } from '@/app/api/exceptions/[id]/route';
import { NextRequest } from 'next/server';
import { createToken } from '@/lib/auth';
import { startSession, advanceSession, provisionTenantFromSession, requestGoLive } from '@/lib/tenants/onboarding-session';

function tenantToken(tenantId: number): string {
  return createToken({
    userId: 'test-user', email: 'test@myra.dev', role: 'admin',
    firstName: 'Test', lastName: 'User', tenantId, tenantIds: [tenantId],
    isSuperAdmin: false,
  });
}

describe('PATCH /api/exceptions/:id resolves a tenant_onboarding go-live request', () => {
  let tenantId: number;
  let sessionId: number;

  afterEach(async () => {
    if (sessionId) await db.query(`DELETE FROM tenant_onboarding_sessions WHERE id = $1`, [sessionId]);
    if (tenantId) {
      await db.query(`DELETE FROM exceptions WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM exception_classification_rules WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
  });

  it('flips tenants.status to active and session to live on resolve', async () => {
    const started = await startSession();
    sessionId = started.sessionId;
    const slug = `t28-resolve-${Date.now()}`;
    await advanceSession(sessionId, 'company_created', {
      companyName: 'Resolve Test Co', slug, tenantType: 'saas_customer', freightBusinessType: 'broker',
    });
    const provisioned = await provisionTenantFromSession(sessionId);
    tenantId = provisioned.tenantId;
    await requestGoLive(sessionId);

    const { rows: excRows } = await db.query<{ id: number }>(
      `SELECT id FROM exceptions WHERE tenant_id = $1 AND source_module = 'tenant_onboarding'`, [tenantId],
    );
    const exceptionId = excRows[0].id;

    const headers = new Headers({ 'content-type': 'application/json' });
    headers.set('cookie', `auth-token=${tenantToken(tenantId)}`);
    const req = new NextRequest(`http://localhost/api/exceptions/${exceptionId}`, {
      method: 'PATCH', body: JSON.stringify({ action: 'resolve' }), headers,
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: String(exceptionId) }) });
    expect(res.status).toBe(200);

    const { rows: tenantRows } = await db.query<{ status: string }>(`SELECT status FROM tenants WHERE id = $1`, [tenantId]);
    expect(tenantRows[0].status).toBe('active');

    const { rows: sessionRows } = await db.query<{ current_step: string; status: string }>(
      `SELECT current_step, status FROM tenant_onboarding_sessions WHERE id = $1`, [sessionId],
    );
    expect(sessionRows[0].current_step).toBe('live');
    expect(sessionRows[0].status).toBe('completed');
  });
});
