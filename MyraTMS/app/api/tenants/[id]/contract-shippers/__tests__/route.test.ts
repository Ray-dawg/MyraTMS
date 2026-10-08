// T-30 Task 10 — integration test for the per-tenant contract-shipper
// whitelist CRUD. Super-admin-only, same gate as the sibling
// onboarding-status route. Fixture ids are reset in afterEach so one test's
// cleanup cannot re-delete another test's row (Task 7 bug).
import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { GET, POST } from '@/app/api/tenants/[id]/contract-shippers/route';
import { createToken } from '@/lib/auth';
import { getMyraTenantId } from '@/lib/tenants/get-myra-tenant-id';

function superAdminToken(tenantId: number): string {
  return createToken({
    userId: 'sa', email: 'sa@myra.dev', role: 'admin', firstName: 'S', lastName: 'A',
    tenantId, tenantIds: [tenantId], isSuperAdmin: true,
  });
}

function headersFor(token: string): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('cookie', `auth-token=${token}`);
  return headers;
}

describe('/api/tenants/:id/contract-shippers', () => {
  let authId: number | null = null;

  afterEach(async () => {
    if (authId) await db.query(`DELETE FROM contract_shipper_authorizations WHERE id = $1`, [authId]);
    authId = null;
  });

  it('POST creates an authorization row, GET lists it', async () => {
    const tenantId = await getMyraTenantId();
    const email = `crud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@shipper.example.com`;
    const headers = headersFor(superAdminToken(tenantId));

    const postReq = new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, {
      method: 'POST',
      body: JSON.stringify({
        shipperEmail: email.toUpperCase(),
        shipperCompanyName: 'Test Co',
        marginFloorOverrideAmount: 275.5,
        authorizedBy: 'test-suite',
      }),
      headers,
    });
    const postRes = await POST(postReq, { params: Promise.resolve({ id: String(tenantId) }) });
    expect(postRes.status).toBe(201);
    const created = await postRes.json();
    authId = Number(created.id);
    expect(Number.isInteger(authId)).toBe(true);

    const getReq = new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, { headers });
    const getRes = await GET(getReq, { params: Promise.resolve({ id: String(tenantId) }) });
    expect(getRes.status).toBe(200);
    const list = await getRes.json();
    const row = list.find((r: { shipper_email: string }) => r.shipper_email === email.toLowerCase());
    expect(row).toBeDefined();
    expect(row.shipper_company_name).toBe('Test Co');
    // NUMERIC comes back from Neon as a string.
    expect(Number(row.margin_floor_override_amount)).toBe(275.5);
    expect(row.is_active).toBe(true);
    expect(row.authorized_by).toBe('test-suite');
  });

  it('returns 409 rather than a 500 on the UNIQUE (tenant_id, shipper_email) collision', async () => {
    const tenantId = await getMyraTenantId();
    const email = `dupe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@shipper.example.com`;
    const headers = headersFor(superAdminToken(tenantId));
    const makeReq = () =>
      new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, {
        method: 'POST',
        body: JSON.stringify({ shipperEmail: email, authorizedBy: 'test-suite' }),
        headers,
      });

    const first = await POST(makeReq(), { params: Promise.resolve({ id: String(tenantId) }) });
    expect(first.status).toBe(201);
    authId = Number((await first.json()).id);

    const second = await POST(makeReq(), { params: Promise.resolve({ id: String(tenantId) }) });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/already authorized/i);
  });

  it('rejects a POST missing shipperEmail/authorizedBy', async () => {
    const tenantId = await getMyraTenantId();
    const req = new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, {
      method: 'POST',
      body: JSON.stringify({ shipperCompanyName: 'No Email Co' }),
      headers: headersFor(superAdminToken(tenantId)),
    });
    const res = await POST(req, { params: Promise.resolve({ id: String(tenantId) }) });
    expect(res.status).toBe(400);
  });

  it('rejects a non-super-admin', async () => {
    const tenantId = await getMyraTenantId();
    const token = createToken({
      userId: 'u', email: 'u@myra.dev', role: 'admin', firstName: 'U', lastName: 'U',
      tenantId, tenantIds: [tenantId], isSuperAdmin: false,
    });
    const req = new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, {
      headers: headersFor(token),
    });
    const res = await GET(req, { params: Promise.resolve({ id: String(tenantId) }) });
    expect(res.status).toBe(403);
  });

  it('rejects an unauthenticated caller with 401', async () => {
    const tenantId = await getMyraTenantId();
    const req = new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`);
    const res = await GET(req, { params: Promise.resolve({ id: String(tenantId) }) });
    expect(res.status).toBe(401);
  });

  it('rejects a non-numeric tenant id', async () => {
    const tenantId = await getMyraTenantId();
    const req = new NextRequest('http://localhost/api/tenants/abc/contract-shippers', {
      headers: headersFor(superAdminToken(tenantId)),
    });
    const res = await GET(req, { params: Promise.resolve({ id: 'abc' }) });
    expect(res.status).toBe(400);
  });
});
