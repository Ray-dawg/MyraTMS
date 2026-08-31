import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { checkSenderAuthorization } from '@/lib/contract-intake/authorization';

describe('checkSenderAuthorization (acceptance criterion 1)', () => {
  let tenantId: number;
  let authId: number;

  afterEach(async () => {
    if (authId) await db.query(`DELETE FROM contract_shipper_authorizations WHERE id = $1`, [authId]);
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
});
