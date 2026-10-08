import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { checkSenderAuthorization } from '@/lib/contract-intake/authorization';

describe('checkSenderAuthorization (acceptance criterion 1)', () => {
  let tenantId: number;
  let authId: number;

  afterEach(async () => {
    if (authId) await db.query(`DELETE FROM contract_shipper_authorizations WHERE id = $1`, [authId]);
    authId = 0;
  });

  it('returns the matching row for an authorized, active sender', async () => {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM tenants LIMIT 1`);
    tenantId = rows[0].id;
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO contract_shipper_authorizations (tenant_id, shipper_email, authorized_by, margin_floor_override_amount)
       VALUES ($1, $2, 'test-suite', 150.00) RETURNING id`,
      [tenantId, `authorized-${Date.now()}@shipper.example.com`],
    );
    authId = inserted.rows[0].id;
    const emailRow = await db.query<{ shipper_email: string }>(`SELECT shipper_email FROM contract_shipper_authorizations WHERE id = $1`, [authId]);

    const result = await checkSenderAuthorization(emailRow.rows[0].shipper_email);
    expect(result).not.toBeNull();
    expect(result?.tenantId).toBe(tenantId);
    expect(result?.marginFloorOverrideAmount).toBe(150);
  });

  it('returns null for an unauthorized sender (same tenant has no row for this address)', async () => {
    const result = await checkSenderAuthorization(`never-authorized-${Date.now()}@nobody.example.com`);
    expect(result).toBeNull();
  });

  it('returns null for a deactivated (is_active=false) authorization', async () => {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM tenants LIMIT 1`);
    tenantId = rows[0].id;
    const email = `deactivated-${Date.now()}@shipper.example.com`;
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO contract_shipper_authorizations (tenant_id, shipper_email, authorized_by, is_active)
       VALUES ($1, $2, 'test-suite', false) RETURNING id`,
      [tenantId, email],
    );
    authId = inserted.rows[0].id;
    const result = await checkSenderAuthorization(email);
    expect(result).toBeNull();
  });

  it('matches case-insensitively, so a mixed-case stored row stays readable', async () => {
    const { rows } = await db.query<{ id: number }>(`SELECT id FROM tenants LIMIT 1`);
    tenantId = rows[0].id;
    const email = `MixedCase-${Date.now()}@Shipper.Example.COM`;
    const inserted = await db.query<{ id: number }>(
      `INSERT INTO contract_shipper_authorizations (tenant_id, shipper_email, authorized_by)
       VALUES ($1, $2, 'test-suite') RETURNING id`,
      [tenantId, email],
    );
    authId = inserted.rows[0].id;
    const result = await checkSenderAuthorization(email.toLowerCase());
    expect(Number(result?.id)).toBe(Number(authId));
  });
});

// Layer (a) of the one-tenant-per-shipper-email fix: migration 059's partial
// unique index. It is what makes the global (tenant-filter-free) read in
// checkSenderAuthorization() safe, so it is asserted at the DB level rather
// than trusted.
describe('uq_contract_shipper_auth_active_email (structural invariant)', () => {
  let email: string | null = null;

  afterEach(async () => {
    if (email) await db.query(`DELETE FROM contract_shipper_authorizations WHERE lower(shipper_email) = $1`, [email]);
    email = null;
  });

  it('refuses a second ACTIVE authorization for the same address under a different tenant', async () => {
    const tenants = await db.query<{ id: string }>(`SELECT id FROM tenants ORDER BY id LIMIT 2`);
    expect(tenants.rows.length).toBe(2);
    const [tenantA, tenantB] = tenants.rows.map((r) => Number(r.id));
    email = `collide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@shipper.example.com`;

    await db.query(
      `INSERT INTO contract_shipper_authorizations (tenant_id, shipper_email, authorized_by)
       VALUES ($1, $2, 'test-suite')`,
      [tenantA, email],
    );

    await expect(
      db.query(
        `INSERT INTO contract_shipper_authorizations (tenant_id, shipper_email, authorized_by)
         VALUES ($1, $2, 'test-suite')`,
        [tenantB, email],
      ),
    ).rejects.toThrow(/uq_contract_shipper_auth_active_email|duplicate key/i);

    // ...so the reader is unambiguous by construction.
    const result = await checkSenderAuthorization(email);
    expect(Number(result?.tenantId)).toBe(tenantA);
  });

  it('permits a deactivated row alongside an active one, but refuses to flip it active', async () => {
    const tenants = await db.query<{ id: string }>(`SELECT id FROM tenants ORDER BY id LIMIT 2`);
    const [tenantA, tenantB] = tenants.rows.map((r) => Number(r.id));
    email = `revoked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@shipper.example.com`;

    const inactive = await db.query<{ id: number }>(
      `INSERT INTO contract_shipper_authorizations (tenant_id, shipper_email, authorized_by, is_active)
       VALUES ($1, $2, 'test-suite', false) RETURNING id`,
      [tenantB, email],
    );
    await db.query(
      `INSERT INTO contract_shipper_authorizations (tenant_id, shipper_email, authorized_by)
       VALUES ($1, $2, 'test-suite')`,
      [tenantA, email],
    );

    await expect(
      db.query(`UPDATE contract_shipper_authorizations SET is_active = true WHERE id = $1`, [inactive.rows[0].id]),
    ).rejects.toThrow(/uq_contract_shipper_auth_active_email|duplicate key/i);
  });
});

// Layer (b): the fail-closed branch itself. With the index in place the
// two-active-rows state is genuinely unconstructible in the database — the
// suite above proves both the INSERT and the UPDATE route are blocked — so
// this branch is exercised against a stubbed adapter. It is not dead code:
// it is the guard for an environment where the index is absent (a branch
// created before this fix, or one where it was dropped).
describe('checkSenderAuthorization fails closed on an ambiguous sender', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@/lib/pipeline/db-adapter');
    vi.restoreAllMocks();
  });

  it('returns null and warns, naming every colliding tenant', async () => {
    vi.doMock('@/lib/pipeline/db-adapter', () => ({
      db: {
        query: vi.fn().mockResolvedValue({
          rows: [
            { id: 11, tenant_id: 2, shipper_email: 'both@shipper.example.com', margin_floor_override_amount: '150.00' },
            { id: 12, tenant_id: 7, shipper_email: 'both@shipper.example.com', margin_floor_override_amount: null },
          ],
          rowCount: 2,
        }),
      },
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { checkSenderAuthorization: fn } = await import('@/lib/contract-intake/authorization');

    const result = await fn('BOTH@shipper.example.com');
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('ambiguous sender');
    expect(line).toContain('both@shipper.example.com');
    // The warning has to name the colliding tenants or an operator cannot act on it.
    expect(line).toContain('"tenantIds":[2,7]');
    expect(line).toContain('"authorizationIds":[11,12]');
  });
});
