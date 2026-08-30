/**
 * T-28 Task 3 — behavior-preserving refactor baseline.
 *
 * Snapshot test for POST /api/admin/tenants written BEFORE the route was
 * refactored to call lib/tenants/provision.ts's createTenantRow(). Confirms
 * response shape (201, tenant.slug echo, onboardUrl) is unchanged across the
 * refactor. Auth pattern reused from __tests__/governance/api.test.ts —
 * createToken() + 'auth-token' cookie on a real NextRequest, no mocking of
 * requireSuperAdmin/getCurrentUser.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createToken } from '@/lib/auth';
import { db } from '@/lib/pipeline/db-adapter';
import { POST } from '../route';

function superAdminToken(): string {
  return createToken({
    userId: 'test-user', email: 'test@myra.dev', role: 'admin',
    firstName: 'Test', lastName: 'User', tenantId: 2, tenantIds: [2],
    isSuperAdmin: true,
  });
}

function postRequest(body: unknown, token?: string): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set('cookie', `auth-token=${token}`);
  return new NextRequest('http://localhost/api/admin/tenants', {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });
}

const createdTenantIds: number[] = [];

afterEach(async () => {
  for (const id of createdTenantIds.splice(0)) {
    await db.query(`DELETE FROM tenant_audit_log WHERE tenant_id = $1`, [id]);
    await db.query(`DELETE FROM tenants WHERE id = $1`, [id]);
  }
});

describe('POST /api/admin/tenants (pre/post-refactor baseline)', () => {
  it('creates a tenant and returns the same response shape as today', async () => {
    const slug = `t28-rfc-${Date.now()}`;
    const req = postRequest(
      { slug, name: 'Refactor Check Co', type: 'saas_customer' },
      superAdminToken(),
    );
    const res = await POST(req);
    const body = await res.json();
    if (res.status === 201) createdTenantIds.push(body.tenant.id);
    expect(res.status).toBe(201);
    expect(body.tenant.slug).toBe(slug);
    expect(body.onboardUrl).toBe(`/api/admin/tenants/${body.tenant.id}/onboard`);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const req = postRequest({ slug: `t28-na-${Date.now()}`, name: 'Noauth Co', type: 'saas_customer' });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 409 on a duplicate slug', async () => {
    const slug = `t28-dc-${Date.now()}`;
    const token = superAdminToken();
    const first = await POST(postRequest({ slug, name: 'Dupe Co', type: 'saas_customer' }, token));
    const firstBody = await first.json();
    createdTenantIds.push(firstBody.tenant.id);
    expect(first.status).toBe(201);

    const second = await POST(postRequest({ slug, name: 'Dupe Co Again', type: 'saas_customer' }, token));
    expect(second.status).toBe(409);
  });

  it('returns 400 on an invalid body', async () => {
    const req = postRequest({ slug: '', name: '', type: 'not-a-real-type' }, superAdminToken());
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
