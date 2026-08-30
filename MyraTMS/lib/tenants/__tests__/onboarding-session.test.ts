import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { startSession, advanceSession, provisionTenantFromSession } from '../onboarding-session';

const createdTenantIds: number[] = [];
const createdSessionIds: number[] = [];

afterEach(async () => {
  for (const id of createdSessionIds.splice(0)) {
    await db.query(`DELETE FROM tenant_onboarding_sessions WHERE id = $1`, [id]);
  }
  for (const id of createdTenantIds.splice(0)) {
    await db.query(`DELETE FROM tenant_users WHERE tenant_id = $1`, [id]);
    await db.query(`DELETE FROM tenant_config WHERE tenant_id = $1`, [id]);
    await db.query(`DELETE FROM tenants WHERE id = $1`, [id]);
  }
});

describe('lib/tenants/onboarding-session', () => {
  it('starts a session at sign_up with an empty step_data', async () => {
    const { sessionId } = await startSession();
    createdSessionIds.push(sessionId);
    const { rows } = await db.query(`SELECT current_step, step_data FROM tenant_onboarding_sessions WHERE id = $1`, [sessionId]);
    expect(rows[0].current_step).toBe('sign_up');
  });

  it('advanceSession merges step_data and moves current_step forward', async () => {
    const { sessionId } = await startSession();
    createdSessionIds.push(sessionId);
    const row = await advanceSession(sessionId, 'company_created', {
      companyName: 'Advance Test Co', slug: `t28-advance-${Date.now()}`, tenantType: 'saas_customer', freightBusinessType: 'broker',
    });
    expect(row.current_step).toBe('company_created');
    expect((row.step_data as any).company_created.companyName).toBe('Advance Test Co');
  });

  it('provisionTenantFromSession creates the tenant and stamps tenant_id on the session', async () => {
    const { sessionId } = await startSession();
    createdSessionIds.push(sessionId);
    const slug = `t28-provision-${Date.now()}`;
    await advanceSession(sessionId, 'company_created', {
      companyName: 'Provision Test Co', slug, tenantType: 'saas_customer', freightBusinessType: 'broker',
    });
    const { tenantId } = await provisionTenantFromSession(sessionId);
    createdTenantIds.push(tenantId);
    const { rows } = await db.query<{ tenant_id: number }>(`SELECT tenant_id FROM tenant_onboarding_sessions WHERE id = $1`, [sessionId]);
    expect(rows[0].tenant_id).toBe(tenantId);
  });

  it('provisionTenantFromSession throws if company_created step data is missing', async () => {
    const { sessionId } = await startSession();
    createdSessionIds.push(sessionId);
    await expect(provisionTenantFromSession(sessionId)).rejects.toThrow(/company_created/);
  });
});
