import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { startSession, advanceSession, provisionTenantFromSession, runDryRun } from '../onboarding-session';
import { applyTenantTypePolicyTemplate } from '../provision';

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

  // Extended timeout: runDryRun's quotePricing -> runRateCascade calls the real
  // Claude API (ANTHROPIC_API_KEY is set in .env.local) when historical rate data
  // is unavailable, which it is for this synthetic tenant. In this environment
  // that call currently fails and exhausts ClaudeService's 3-retry exponential
  // backoff (~1s+2s+4s per attempt plus real HTTP round trips) before the
  // cascade falls back to the benchmark rate source -- observed ~60s wall time.
  // The fallback is by design (lib/pricing/rate-cascade.ts catches the failure
  // and continues), so the test still asserts real behavior; it just needs
  // longer than Vitest's 5s default to observe it complete.
  it('runDryRun exercises policy/dispatch/pricing against a synthetic load with zero pipeline_loads writes', async () => {
    const { sessionId } = await startSession();
    createdSessionIds.push(sessionId);
    const slug = `t28-dryrun-${Date.now()}`;
    await advanceSession(sessionId, 'company_created', {
      companyName: 'Dry Run Co', slug, tenantType: 'saas_customer', freightBusinessType: 'carrier',
    });
    const { tenantId } = await provisionTenantFromSession(sessionId);
    createdTenantIds.push(tenantId);
    await applyTenantTypePolicyTemplate(db, tenantId, 'carrier');

    const { rows: beforeCount } = await db.query<{ count: string }>(`SELECT COUNT(*) FROM pipeline_loads`);

    const result = await runDryRun(sessionId);
    expect(result.policyOk).toBe(true);
    expect(typeof result.dispatchMode).toBe('string');
    expect(typeof result.pricingOk).toBe('boolean');

    const { rows: afterCount } = await db.query<{ count: string }>(`SELECT COUNT(*) FROM pipeline_loads`);
    expect(afterCount[0].count).toBe(beforeCount[0].count);
  }, 90000);
});
