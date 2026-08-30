import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import {
  createTenantRow, cloneDefaultTenantConfig, seatTenantOwner,
  applyTenantTypePolicyTemplate, captureBillingIntent,
} from '../provision';

const createdTenantIds: number[] = [];

afterEach(async () => {
  for (const id of createdTenantIds.splice(0)) {
    await db.query(`DELETE FROM tenant_policies WHERE tenant_id = $1`, [id]);
    await db.query(`DELETE FROM tenant_subscriptions WHERE tenant_id = $1`, [id]);
    await db.query(`DELETE FROM tenant_config WHERE tenant_id = $1`, [id]);
    await db.query(`DELETE FROM tenant_users WHERE tenant_id = $1`, [id]);
    await db.query(`DELETE FROM tenants WHERE id = $1`, [id]);
  }
});

describe('lib/tenants/provision', () => {
  it('createTenantRow inserts a tenant with both type axes set', async () => {
    const { tenantId } = await createTenantRow(db, {
      slug: `t28-test-${Date.now()}`, name: 'T-28 Test Co',
      type: 'saas_customer', freightBusinessType: 'broker',
    });
    createdTenantIds.push(tenantId);
    const { rows } = await db.query<{ type: string; freight_business_type: string }>(
      `SELECT type, freight_business_type FROM tenants WHERE id = $1`, [tenantId],
    );
    expect(rows[0].type).toBe('saas_customer');
    expect(rows[0].freight_business_type).toBe('broker');
  });

  it('cloneDefaultTenantConfig is idempotent — second call adds zero rows', async () => {
    const { tenantId } = await createTenantRow(db, {
      slug: `t28-test-${Date.now()}`, name: 'T-28 Test Co 2', type: 'saas_customer',
    });
    createdTenantIds.push(tenantId);
    const first = await cloneDefaultTenantConfig(db, tenantId);
    const second = await cloneDefaultTenantConfig(db, tenantId);
    expect(first.configRowsAdded).toBeGreaterThan(0);
    expect(second.configRowsAdded).toBe(0);
  });

  it('applyTenantTypePolicyTemplate maps dispatch_agent_default correctly per type', async () => {
    const { tenantId } = await createTenantRow(db, {
      slug: `t28-test-${Date.now()}`, name: 'T-28 Carrier Co', type: 'saas_customer',
    });
    createdTenantIds.push(tenantId);
    await applyTenantTypePolicyTemplate(db, tenantId, 'carrier');
    const { rows } = await db.query<{ dispatch_agent_enabled: boolean; load_source_policy: string }>(
      `SELECT dispatch_agent_enabled, load_source_policy FROM tenant_policies WHERE tenant_id = $1 AND is_active = true`,
      [tenantId],
    );
    expect(rows[0].dispatch_agent_enabled).toBe(false); // 'opt_in' template maps to false-by-default
    expect(rows[0].load_source_policy).toBe('any');
  });

  it('applyTenantTypePolicyTemplate rejects acquired_opco — inherit semantics are unresolved', async () => {
    const { tenantId } = await createTenantRow(db, {
      slug: `t28-test-${Date.now()}`, name: 'T-28 Opco', type: 'saas_customer',
    });
    createdTenantIds.push(tenantId);
    // @ts-expect-error — acquired_opco is intentionally not in the accepted type union
    await expect(applyTenantTypePolicyTemplate(db, tenantId, 'acquired_opco')).rejects.toThrow(/inherit/i);
  });

  it('captureBillingIntent upserts tenant_subscriptions.tier without touching billing_provider', async () => {
    const { tenantId } = await createTenantRow(db, {
      slug: `t28-test-${Date.now()}`, name: 'T-28 Billing Co', type: 'saas_customer',
    });
    createdTenantIds.push(tenantId);
    await captureBillingIntent(db, tenantId, 'pro');
    const { rows } = await db.query<{ tier: string; billing_provider: string | null }>(
      `SELECT tier, billing_provider FROM tenant_subscriptions WHERE tenant_id = $1`, [tenantId],
    );
    expect(rows[0].tier).toBe('pro');
    expect(rows[0].billing_provider).toBeNull();
  });

  it('seatTenantOwner clears is_primary on the user\'s other tenants before setting the new one', async () => {
    const { tenantId } = await createTenantRow(db, {
      slug: `t28-test-${Date.now()}`, name: 'T-28 Owner Co', type: 'saas_customer',
    });
    createdTenantIds.push(tenantId);
    const { rows: users } = await db.query<{ id: string }>(`SELECT id FROM users LIMIT 1`);
    const userId = users[0].id;
    const { ownerSeated } = await seatTenantOwner(db, tenantId, userId);
    expect(ownerSeated).toBe(true);
    const { rows: primaryRows } = await db.query<{ tenant_id: number }>(
      `SELECT tenant_id FROM tenant_users WHERE user_id = $1 AND is_primary = true`, [userId],
    );
    expect(primaryRows).toHaveLength(1);
    expect(primaryRows[0].tenant_id).toBe(tenantId);
  });
});
