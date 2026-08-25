/**
 * T-19 evaluatePolicy() integration tests — the DB wrapper around
 * applyPolicy(). Point DATABASE_URL at the Neon verification branch.
 * Mirrors T-18's evaluate-authority.test.ts pattern: a disposable test
 * tenant + its own tenant_policies/authority_envelopes rows, so Myra's
 * real active policy is never touched.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { evaluatePolicy } from '@/lib/governance/evaluate-policy-db';

const RUN_ID = `T19-EP-${Date.now()}`;
let tenantId: number;
let policyEngineAgentId: number;

beforeAll(async () => {
  const tenant = await db.query<{ id: number }>(
    `INSERT INTO tenants (slug, name, type, status)
     VALUES ($1, $2, 'internal', 'active') RETURNING id`,
    [`${RUN_ID}-tenant`, `${RUN_ID} Test Tenant`],
  );
  tenantId = tenant.rows[0].id;

  const agent = await db.query<{ id: number }>(
    `SELECT id FROM agents WHERE agent_key = 'policy_engine'`,
  );
  policyEngineAgentId = agent.rows[0].id;

  await db.query(
    `INSERT INTO authority_envelopes (
       agent_id, tenant_id, version, envelope_name, permissions, tools, budget, policies,
       confidence_threshold, autonomy_default, escalation_rules, created_by
     ) VALUES ($1, $2, 1, $3, $4, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, 0.700, 'L2', '[]'::jsonb, 'test')`,
    [
      policyEngineAgentId,
      tenantId,
      `${RUN_ID}-envelope`,
      JSON.stringify({ can: ['evaluate_load_source_policy'], cannot: [] }),
    ],
  );

  await db.query(
    `INSERT INTO tenant_policies (
       tenant_id, version, load_source_policy, dispatch_agent_enabled, negotiation_directions,
       geographic_scope, created_by
     ) VALUES ($1, 1, 'shipper_direct_or_coBroker', true, 'both', $2::jsonb, 'test')`,
    [tenantId, JSON.stringify({ domestic_only: true, countries: ['CA'] })],
  );
});

afterAll(async () => {
  await db.query(`DELETE FROM authority_evaluations WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM events WHERE derived_from_table = $1`, [`${RUN_ID}-idempotency`]);
  await db.query(`DELETE FROM authority_envelopes WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_policies WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM co_broker_agreements WHERE tenant_id = $1`, [tenantId]);
  await db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
});

const domesticDirectLoad = {
  isDirect: true,
  postingSource: 'manual',
  originCountry: 'CA',
  destinationCountry: 'CA',
};

describe('evaluatePolicy', () => {
  it('loads the active tenant_policies row, evaluates, and writes an authority_evaluations row', async () => {
    const result = await evaluatePolicy({ tenantId, load: domesticDirectLoad });
    expect(result.decision).toBe('accept');

    const rows = await db.query(
      `SELECT decision FROM authority_evaluations WHERE tenant_id = $1 AND action = 'evaluate_load_source_policy'`,
      [tenantId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows[0].decision).toBe('allow');
  });

  it('rejects a broker-posted load with no co-broker agreement and logs deny', async () => {
    const result = await evaluatePolicy({
      tenantId,
      load: { ...domesticDirectLoad, isDirect: false, postingCompanyMcNumber: 'MC999' },
    });
    expect(result.decision).toBe('reject');

    const rows = await db.query(
      `SELECT decision FROM authority_evaluations
        WHERE tenant_id = $1 AND action = 'evaluate_load_source_policy' AND decision = 'deny'`,
      [tenantId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
  });

  it('is idempotent on source_event_id: a second call with the same sourceEventId does not duplicate', async () => {
    // A dedicated row, not "the latest event" -- picking the latest races
    // against every other test file's own concurrent event inserts/deletes,
    // which can delete the chosen row between this test's two calls.
    const ownEvent = await db.query<{ id: number }>(
      `INSERT INTO events (
         tenant_id, event_type, entity_type, entity_id, source, actor_type,
         occurred_at, derived_from_table, derived_from_id
       ) VALUES ($1, 'test.policy_idempotency', 'test', 1, 'test', 'system', LOCALTIMESTAMP, $2, 1)
       RETURNING id`,
      [tenantId, `${RUN_ID}-idempotency`],
    );
    const eventId = ownEvent.rows[0].id;

    const first = await evaluatePolicy({ tenantId, load: domesticDirectLoad, sourceEventId: eventId });
    const second = await evaluatePolicy({ tenantId, load: domesticDirectLoad, sourceEventId: eventId });
    expect(second.decision).toBe(first.decision);

    const rows = await db.query(
      `SELECT id FROM authority_evaluations WHERE source_event_id = $1`,
      [eventId],
    );
    expect(rows.rows.length).toBe(1);
  });

  it('throws a clear error when no active tenant_policies row exists for the tenant', async () => {
    const otherTenant = await db.query<{ id: number }>(
      `INSERT INTO tenants (slug, name, type, status) VALUES ($1, $2, 'internal', 'active') RETURNING id`,
      [`${RUN_ID}-no-policy`, `${RUN_ID} No Policy Tenant`],
    );
    try {
      await expect(
        evaluatePolicy({ tenantId: otherTenant.rows[0].id, load: domesticDirectLoad }),
      ).rejects.toThrow(/no active tenant_policies row/);
    } finally {
      await db.query(`DELETE FROM tenants WHERE id = $1`, [otherTenant.rows[0].id]);
    }
  });
});
