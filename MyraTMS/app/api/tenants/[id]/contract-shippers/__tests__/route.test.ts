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

const SUPER_ADMIN_EMAIL = 'sa@myra.dev';

describe('/api/tenants/:id/contract-shippers', () => {
  // Cleanup keys off the email as well as the id: on a non-201 there is no id
  // to capture, and `Number(undefined)` would be NaN, which `if (authId)`
  // skips — leaking any row a partially-successful test did create.
  const createdEmails: string[] = [];

  function track(email: string): string {
    createdEmails.push(email.toLowerCase());
    return email;
  }

  afterEach(async () => {
    for (const email of createdEmails) {
      await db.query(`DELETE FROM contract_shipper_authorizations WHERE lower(shipper_email) = $1`, [email]);
    }
    createdEmails.length = 0;
  });

  it('POST creates an authorization row, GET lists it', async () => {
    const tenantId = await getMyraTenantId();
    const email = track(`crud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@shipper.example.com`);
    const headers = headersFor(superAdminToken(tenantId));

    const postReq = new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, {
      method: 'POST',
      body: JSON.stringify({
        shipperEmail: email.toUpperCase(),
        shipperCompanyName: 'Test Co',
        marginFloorOverrideAmount: 275.5,
        // Ignored on purpose — authorized_by is the audit trail for a control
        // that permits real bookings, so it comes from the verified JWT.
        authorizedBy: 'not-the-caller',
      }),
      headers,
    });
    const postRes = await POST(postReq, { params: Promise.resolve({ id: String(tenantId) }) });
    expect(postRes.status).toBe(201);
    const created = await postRes.json();
    expect(Number.isInteger(Number(created.id))).toBe(true);

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
    expect(row.authorized_by).toBe(SUPER_ADMIN_EMAIL);
  });

  it('returns 409 rather than a 500 on the UNIQUE (tenant_id, shipper_email) collision', async () => {
    const tenantId = await getMyraTenantId();
    const email = track(`dupe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@shipper.example.com`);
    const headers = headersFor(superAdminToken(tenantId));
    const makeReq = () =>
      new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, {
        method: 'POST',
        body: JSON.stringify({ shipperEmail: email }),
        headers,
      });

    const first = await POST(makeReq(), { params: Promise.resolve({ id: String(tenantId) }) });
    expect(first.status).toBe(201);

    const second = await POST(makeReq(), { params: Promise.resolve({ id: String(tenantId) }) });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error).toMatch(/already authorized/i);
    expect(body.details.isActive).toBe(true);
  });

  it('tells the truth about a deactivated row instead of calling it authorized', async () => {
    const tenantId = await getMyraTenantId();
    const email = track(`revoked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@shipper.example.com`);
    const headers = headersFor(superAdminToken(tenantId));
    const makeReq = () =>
      new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, {
        method: 'POST',
        body: JSON.stringify({ shipperEmail: email }),
        headers,
      });

    expect((await POST(makeReq(), { params: Promise.resolve({ id: String(tenantId) }) })).status).toBe(201);
    // Deactivated out of band, as a future revoke verb (T-30b) would do.
    await db.query(
      `UPDATE contract_shipper_authorizations SET is_active = false WHERE lower(shipper_email) = $1`,
      [email],
    );

    const res = await POST(makeReq(), { params: Promise.resolve({ id: String(tenantId) }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/deactivated/i);
    expect(body.error).not.toMatch(/is already authorized/i);
    expect(body.details.isActive).toBe(false);
  });

  it('refuses to authorize the same address for a second tenant, naming the holder', async () => {
    const tenantId = await getMyraTenantId();
    const others = await db.query<{ id: string }>(
      `SELECT id FROM tenants WHERE id <> $1 ORDER BY id LIMIT 1`,
      [tenantId],
    );
    expect(others.rows).toHaveLength(1);
    const otherTenantId = Number(others.rows[0].id);
    const email = track(`cross-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@shipper.example.com`);
    const headers = headersFor(superAdminToken(tenantId));

    const firstRes = await POST(
      new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, {
        method: 'POST', body: JSON.stringify({ shipperEmail: email }), headers,
      }),
      { params: Promise.resolve({ id: String(tenantId) }) },
    );
    expect(firstRes.status).toBe(201);

    const secondRes = await POST(
      new NextRequest(`http://localhost/api/tenants/${otherTenantId}/contract-shippers`, {
        method: 'POST', body: JSON.stringify({ shipperEmail: email }), headers,
      }),
      { params: Promise.resolve({ id: String(otherTenantId) }) },
    );
    expect(secondRes.status).toBe(409);
    const body = await secondRes.json();
    expect(body.error).toMatch(/at most one tenant/i);
    expect(body.details.conflictingTenantId).toBe(tenantId);
  });

  it('reports a same-tenant casing collision as same-tenant, not "another tenant"', async () => {
    const tenantId = await getMyraTenantId();
    const lower = track(`casing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@shipper.example.com`);
    // Direct SQL, mixed case: (tenant_id, shipper_email) differs so the route's
    // ON CONFLICT does not match, but the global lower() index still trips.
    await db.query(
      `INSERT INTO contract_shipper_authorizations (tenant_id, shipper_email, authorized_by) VALUES ($1, $2, 'test')`,
      [tenantId, lower.toUpperCase().replace('@SHIPPER.EXAMPLE.COM', '@shipper.example.com')],
    );
    const res = await POST(
      new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, {
        method: 'POST',
        body: JSON.stringify({ shipperEmail: lower }),
        headers: headersFor(superAdminToken(tenantId)),
      }),
      { params: Promise.resolve({ id: String(tenantId) }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/this tenant/i);
    expect(body.error).not.toMatch(/another tenant|at most one tenant/i);
    expect(body.details.sameTenant).toBe(true);
  });

  it('rejects a POST missing shipperEmail', async () => {
    const tenantId = await getMyraTenantId();
    const req = new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, {
      method: 'POST',
      body: JSON.stringify({ shipperCompanyName: 'No Email Co' }),
      headers: headersFor(superAdminToken(tenantId)),
    });
    const res = await POST(req, { params: Promise.resolve({ id: String(tenantId) }) });
    expect(res.status).toBe(400);
  });

  // validate-rate.ts resolves the floor with NULLISH coalescing, so a stored 0
  // REPLACES the tenant floor rather than deferring to it, and every tender at
  // or above cost then clears forever for that shipper. Number('') === 0 and
  // Number(true) === 1, so an empty or malformed form field must be a 400 —
  // never a silently-disabled margin check.
  it.each([
    ['an empty string', ''],
    ['a blank string', '  '],
    ['a numeric string', '275.50'],
    ['an explicit zero', 0],
    ['a negative amount', -5],
    ['a boolean', true],
    ['an array', []],
    ['NaN-producing garbage', 'abc'],
    ['an amount beyond NUMERIC(10,2)', 1e9],
    ['exponent notation that would round to 0.00', 1e-7],
    ['more than two decimal places', 275.555],
  ])('rejects marginFloorOverrideAmount: %s', async (_label, value) => {
    const tenantId = await getMyraTenantId();
    const email = track(`floor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@shipper.example.com`);
    const req = new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, {
      method: 'POST',
      body: JSON.stringify({ shipperEmail: email, marginFloorOverrideAmount: value }),
      headers: headersFor(superAdminToken(tenantId)),
    });
    const res = await POST(req, { params: Promise.resolve({ id: String(tenantId) }) });
    expect(res.status).toBe(400);
    // Nothing may be written on a rejected override.
    const rows = await db.query(`SELECT 1 FROM contract_shipper_authorizations WHERE lower(shipper_email) = $1`, [email]);
    expect(rows.rows).toHaveLength(0);
  });

  it('accepts an omitted marginFloorOverrideAmount and stores NULL', async () => {
    const tenantId = await getMyraTenantId();
    const email = track(`nofloor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@shipper.example.com`);
    const req = new NextRequest(`http://localhost/api/tenants/${tenantId}/contract-shippers`, {
      method: 'POST',
      body: JSON.stringify({ shipperEmail: email }),
      headers: headersFor(superAdminToken(tenantId)),
    });
    expect((await POST(req, { params: Promise.resolve({ id: String(tenantId) }) })).status).toBe(201);
    const rows = await db.query<{ margin_floor_override_amount: string | null }>(
      `SELECT margin_floor_override_amount FROM contract_shipper_authorizations WHERE lower(shipper_email) = $1`,
      [email],
    );
    expect(rows.rows[0].margin_floor_override_amount).toBeNull();
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
