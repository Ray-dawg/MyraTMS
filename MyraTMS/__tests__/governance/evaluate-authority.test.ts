/**
 * T-18 evaluateAuthority() integration tests — the DB wrapper around
 * applyEnvelope(). Point DATABASE_URL at the Neon verification branch.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { evaluateAuthority } from '@/lib/governance/evaluate-authority';

const RUN_ID = `T18-EA-${Date.now()}`;
let agentId: number;
let envelopeId: number;

beforeAll(async () => {
  const agent = await db.query<{ id: number }>(
    `INSERT INTO agents (agent_key, display_name, agent_type, status)
     VALUES ($1, 'Test Agent', 'decision', 'shadow') RETURNING id`,
    [`${RUN_ID}-agent`],
  );
  agentId = agent.rows[0].id;

  const envelope = await db.query<{ id: number }>(
    `INSERT INTO authority_envelopes (
       agent_id, tenant_id, version, envelope_name, permissions, budget, policies,
       confidence_threshold, autonomy_default, escalation_rules
     ) VALUES ($1, 1, 1, $2, $3, $4, $5, 0.700, 'L2', $6)
     RETURNING id`,
    [
      agentId,
      `${RUN_ID}-envelope`,
      JSON.stringify({ can: ['test_action'], cannot: ['forbidden_action'] }),
      JSON.stringify({ max_concurrent: 5 }),
      JSON.stringify({ margin_floor_pct: 8 }),
      JSON.stringify([{ trigger: 'margin_below_floor', level: 'L3' }]),
    ],
  );
  envelopeId = envelope.rows[0].id;
});

afterAll(async () => {
  await db.query(`DELETE FROM escalations WHERE evaluation_id IN (SELECT id FROM authority_evaluations WHERE agent_id = $1)`, [agentId]);
  await db.query(`DELETE FROM authority_evaluations WHERE agent_id = $1`, [agentId]);
  await db.query(`DELETE FROM events WHERE derived_from_table = $1`, [`${RUN_ID}-idempotency`]);
  await db.query(`DELETE FROM authority_envelopes WHERE id = $1`, [envelopeId]);
  await db.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
});

describe('evaluateAuthority', () => {
  it('loads the active envelope, evaluates, and writes an authority_evaluations row', async () => {
    const result = await evaluateAuthority({
      agentKey: `${RUN_ID}-agent`,
      tenantId: 1,
      action: 'test_action',
      context: {},
    });
    expect(result.decision).toBe('allow');

    const rows = await db.query(`SELECT decision FROM authority_evaluations WHERE agent_id = $1`, [agentId]);
    expect(rows.rows.length).toBe(1);
  });

  it('writes an escalations row when the decision is escalate', async () => {
    const result = await evaluateAuthority({
      agentKey: `${RUN_ID}-agent`,
      tenantId: 1,
      action: 'test_action',
      context: { marginPct: 2 },
    });
    expect(result.decision).toBe('escalate');

    const esc = await db.query(
      `SELECT e.id FROM escalations e
         JOIN authority_evaluations ev ON ev.id = e.evaluation_id
        WHERE ev.agent_id = $1 AND ev.decision = 'escalate'`,
      [agentId],
    );
    expect(esc.rows.length).toBeGreaterThan(0);
  });

  it('is idempotent on source_event_id: a second call with the same sourceEventId does not duplicate', async () => {
    // source_event_id has an FK to events(id). A dedicated row, not "the
    // latest event" -- picking the latest races against every other test
    // file's own concurrent event inserts/deletes under a full-suite run,
    // which can delete the chosen row between this test's two calls.
    const ownEvent = await db.query<{ id: number }>(
      `INSERT INTO events (
         tenant_id, event_type, entity_type, entity_id, source, actor_type,
         occurred_at, derived_from_table, derived_from_id
       ) VALUES (1, 'test.authority_idempotency', 'test', 1, 'test', 'system', LOCALTIMESTAMP, $1, 1)
       RETURNING id`,
      [`${RUN_ID}-idempotency`],
    );
    const eventId = ownEvent.rows[0].id;

    const first = await evaluateAuthority({
      agentKey: `${RUN_ID}-agent`,
      tenantId: 1,
      action: 'test_action',
      context: {},
      sourceEventId: eventId,
    });
    const second = await evaluateAuthority({
      agentKey: `${RUN_ID}-agent`,
      tenantId: 1,
      action: 'test_action',
      context: {},
      sourceEventId: eventId,
    });
    expect(second.decision).toBe(first.decision);

    const rows = await db.query(
      `SELECT id FROM authority_evaluations WHERE source_event_id = $1`,
      [eventId],
    );
    expect(rows.rows.length).toBe(1);
  });

  it('throws a clear error for an unknown agent_key', async () => {
    await expect(
      evaluateAuthority({ agentKey: 'does-not-exist', tenantId: 1, action: 'x', context: {} }),
    ).rejects.toThrow(/unknown agent_key/);
  });
});
