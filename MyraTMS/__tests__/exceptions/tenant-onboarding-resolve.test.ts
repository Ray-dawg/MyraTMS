/**
 * T-28 Task 7 — approval flips tenant status via the exceptions resolve action.
 *
 * Auth pattern reused from app/api/admin/tenants/__tests__/route.test.ts
 * (itself reused from __tests__/governance/api.test.ts): a real createToken()
 * + 'auth-token' cookie on a real NextRequest, no mocking of getCurrentUser/
 * requireTenantContext. This route is gated by requireTenantContext — per
 * lib/auth.ts, with no x-myra-tenant-* headers on the request,
 * requireTenantContext falls back to getCurrentUser(request) and reads
 * tenantId directly off the JWT — but the go-live activation branch now also
 * requires isSuperAdmin: true (final-review fix, findings 1+2). Since a real
 * super-admin can act with the dynamically-provisioned tenant as their own
 * JWT tenantId (requireTenantContext just needs SOME valid tenant context;
 * the activation itself runs via asServiceAdmin against exc.tenant_id, not
 * ctx.tenantId), the approving token below carries the provisioned tenantId
 * with isSuperAdmin: true, matching the canonical superAdminToken() shape
 * used in app/api/admin/tenants/__tests__/route.test.ts (that test hardcodes
 * tenantId: 2 because it always acts as Myra; this one still needs a
 * dynamically-scoped tenantId so withTenant() can find the exception row).
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
    isSuperAdmin: true,
  });
}

function nonSuperAdminTokenForOtherTenant(otherTenantId: number): string {
  return createToken({
    userId: 'test-user-2', email: 'test2@myra.dev', role: 'admin',
    firstName: 'Test', lastName: 'Two', tenantId: otherTenantId, tenantIds: [otherTenantId],
    isSuperAdmin: false,
  });
}

describe('PATCH /api/exceptions/:id resolves a tenant_onboarding go-live request', () => {
  let tenantId: number;
  let sessionId: number;
  // Used only by the non-super-admin rejection test below, which needs a
  // second, independent tenant to act as the "different tenant" the
  // attacker's own JWT carries (the attacker's own tenant is never
  // provisioned via this flow, so nothing else needs to reference it).
  let otherTenantId: number | undefined;

  afterEach(async () => {
    if (sessionId) await db.query(`DELETE FROM tenant_onboarding_sessions WHERE id = $1`, [sessionId]);
    if (tenantId) {
      await db.query(`DELETE FROM exceptions WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM exception_classification_rules WHERE tenant_id = $1`, [tenantId]);
      await db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
    if (otherTenantId) {
      await db.query(`DELETE FROM exceptions WHERE tenant_id = $1`, [otherTenantId]);
      await db.query(`DELETE FROM exception_classification_rules WHERE tenant_id = $1`, [otherTenantId]);
      await db.query(`DELETE FROM tenants WHERE id = $1`, [otherTenantId]);
      otherTenantId = undefined;
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

  it('a non-super-admin cannot activate another tenant via exception resolve', async () => {
    const started = await startSession();
    sessionId = started.sessionId;
    const slug = `t28-resolve-deny-${Date.now()}`;
    await advanceSession(sessionId, 'company_created', {
      companyName: 'Resolve Deny Test Co', slug, tenantType: 'saas_customer', freightBusinessType: 'broker',
    });
    const provisioned = await provisionTenantFromSession(sessionId);
    tenantId = provisioned.tenantId;
    await requestGoLive(sessionId);

    const { rows: excRows } = await db.query<{ id: number }>(
      `SELECT id FROM exceptions WHERE tenant_id = $1 AND source_module = 'tenant_onboarding'`, [tenantId],
    );
    const exceptionId = excRows[0].id;

    // A separate, unrelated tenant provides a valid-but-different tenantId
    // for the attacker's own JWT context (requireTenantContext just needs
    // some tenant to resolve; the privilege check is on isSuperAdmin, not
    // on which tenant the token names).
    const otherStarted = await startSession();
    const otherSlug = `t28-atk-${Date.now()}`;
    await advanceSession(otherStarted.sessionId, 'company_created', {
      companyName: 'Attacker Co', slug: otherSlug, tenantType: 'saas_customer', freightBusinessType: 'broker',
    });
    const otherProvisioned = await provisionTenantFromSession(otherStarted.sessionId);
    otherTenantId = otherProvisioned.tenantId;
    await db.query(`DELETE FROM tenant_onboarding_sessions WHERE id = $1`, [otherStarted.sessionId]);

    const headers = new Headers({ 'content-type': 'application/json' });
    headers.set('cookie', `auth-token=${nonSuperAdminTokenForOtherTenant(otherTenantId)}`);
    const req = new NextRequest(`http://localhost/api/exceptions/${exceptionId}`, {
      method: 'PATCH', body: JSON.stringify({ action: 'resolve' }), headers,
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: String(exceptionId) }) });
    expect(res.status).toBe(403);

    const { rows: tenantRows } = await db.query<{ status: string }>(`SELECT status FROM tenants WHERE id = $1`, [tenantId]);
    expect(tenantRows[0].status).toBe('trial');
  });
});
