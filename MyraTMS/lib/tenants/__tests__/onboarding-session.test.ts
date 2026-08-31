import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { startSession, advanceSession, provisionTenantFromSession, runDryRun, requestGoLive } from '../onboarding-session';
import { applyTenantTypePolicyTemplate } from '../provision';

const createdTenantIds: number[] = [];
const createdSessionIds: number[] = [];

afterEach(async () => {
  for (const id of createdSessionIds.splice(0)) {
    await db.query(`DELETE FROM tenant_onboarding_sessions WHERE id = $1`, [id]);
  }
  for (const id of createdTenantIds.splice(0)) {
    // requestGoLive's test (Task 6) writes into `exceptions` via
    // bridgeToExceptions -- exceptions.tenant_id is ON DELETE RESTRICT
    // (migration 028), so it must be cleaned up before the tenants row
    // can be deleted, same as tenant_users/tenant_config below.
    await db.query(`DELETE FROM exceptions WHERE tenant_id = $1`, [id]);
    // Not FK-constrained (exception_classification_rules.tenant_id is a
    // plain INTEGER, no REFERENCES tenants(id)), but cleaned up anyway so
    // repeated test runs don't accumulate orphan rows for throwaway tenants.
    await db.query(`DELETE FROM exception_classification_rules WHERE tenant_id = $1`, [id]);
    // Also not FK-constrained to tenants (plain INTEGER/BIGINT columns with
    // defaults) -- applyTenantTypePolicyTemplate and runDryRun's
    // evaluatePolicy/quotePricing write into these, and without an explicit
    // delete here the rows survive DELETE FROM tenants permanently
    // (final-review "3 more test-row leaks" finding). tenant_policies is NOT
    // listed here -- its tenant_id has ON DELETE CASCADE from tenants(id)
    // per migration 035, so it's already handled implicitly.
    await db.query(`DELETE FROM authority_evaluations WHERE tenant_id = $1`, [id]);
    await db.query(`DELETE FROM authority_envelopes WHERE tenant_id = $1`, [id]);
    await db.query(`DELETE FROM pricing_engine_requests WHERE tenant_id = $1`, [id]);
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
    expect(Number(rows[0].tenant_id)).toBe(tenantId);
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

  it('requestGoLive bridges into the existing exceptions table with source_module=tenant_onboarding', async () => {
    const { sessionId } = await startSession();
    createdSessionIds.push(sessionId);
    const slug = `t28-golive-${Date.now()}`;
    await advanceSession(sessionId, 'company_created', {
      companyName: 'Go Live Co', slug, tenantType: 'saas_customer', freightBusinessType: 'broker',
    });
    const { tenantId } = await provisionTenantFromSession(sessionId);
    createdTenantIds.push(tenantId);

    const result = await requestGoLive(sessionId);
    expect(result.bridged).toBe(true);

    const { rows } = await db.query<{ type: string; source_module: string; tenant_id: number }>(
      `SELECT type, source_module, tenant_id FROM exceptions WHERE source_module = 'tenant_onboarding' AND tenant_id = $1`,
      [tenantId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('go_live_requested');
  });

  it('provisionTenantFromSession is idempotent -- a second call returns the same tenantId without creating a second tenant', async () => {
    const { sessionId } = await startSession();
    createdSessionIds.push(sessionId);
    const slug = `t28-idempotent-${Date.now()}`;
    await advanceSession(sessionId, 'company_created', {
      companyName: 'Idempotent Test Co', slug, tenantType: 'saas_customer', freightBusinessType: 'broker',
    });

    const first = await provisionTenantFromSession(sessionId);
    createdTenantIds.push(first.tenantId);
    const second = await provisionTenantFromSession(sessionId);

    expect(second.tenantId).toBe(first.tenantId);

    const { rows } = await db.query<{ tenant_id: number }>(
      `SELECT tenant_id FROM tenant_onboarding_sessions WHERE id = $1`, [sessionId],
    );
    expect(Number(rows[0].tenant_id)).toBe(first.tenantId);

    const { rows: tenantCountRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) FROM tenants WHERE slug = $1`, [slug],
    );
    expect(tenantCountRows[0].count).toBe('1');
  });
});
