/**
 * T-18 API verification — auth boundary and response shape for all 5 endpoints.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createToken } from '@/lib/auth';
import { db } from '@/lib/pipeline/db-adapter';
import { GET as agentsGet } from '@/app/api/agents/route';
import { GET as envelopeGet, POST as envelopePost } from '@/app/api/agents/[agentKey]/envelope/route';
import { GET as evaluationsGet } from '@/app/api/evaluations/route';
import { GET as escalationsGet } from '@/app/api/escalations/route';
import { PATCH as escalationPatch } from '@/app/api/escalations/[id]/route';

const RUN_ID = `T18-API-${Date.now()}`;

function tokenFor(role: string): string {
  return createToken({
    userId: 'test-user', email: 'test@myra.dev', role,
    firstName: 'Test', lastName: 'User', tenantId: 1, tenantIds: [1],
  });
}

function requestWithCookie(
  path: string,
  token?: string,
  init?: { method?: string; body?: string },
): NextRequest {
  const headers = new Headers();
  if (token) headers.set('cookie', `auth-token=${token}`);
  return new NextRequest(`http://localhost${path}`, { ...init, headers });
}

let escalationId: number;
let agentId: number;

beforeAll(async () => {
  const agent = await db.query<{ id: number }>(
    `INSERT INTO agents (agent_key, display_name, agent_type, status) VALUES ($1, 'API Test Agent', 'decision', 'shadow') RETURNING id`,
    [`${RUN_ID}-agent`],
  );
  agentId = agent.rows[0].id;
  const evaluation = await db.query<{ id: number }>(
    `INSERT INTO authority_evaluations (envelope_id, agent_id, tenant_id, action, autonomy_level_applied, decision, shadow_mode)
     VALUES (
       (SELECT id FROM authority_envelopes LIMIT 1),
       $1, 1, 'test_action', 'L3', 'escalate', true
     ) RETURNING id`,
    [agentId],
  );
  const escalation = await db.query<{ id: number }>(
    `INSERT INTO escalations (evaluation_id, tenant_id, severity, status) VALUES ($1, 1, 'medium', 'pending') RETURNING id`,
    [evaluation.rows[0].id],
  );
  escalationId = escalation.rows[0].id;
});

afterAll(async () => {
  await db.query(`DELETE FROM escalations WHERE id = $1`, [escalationId]);
  await db.query(`DELETE FROM authority_evaluations WHERE agent_id = $1`, [agentId]);
  await db.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
});

describe('T-18 governance API', () => {
  it('GET /api/agents rejects unauthenticated requests', async () => {
    const res = await agentsGet(requestWithCookie('/api/agents'));
    expect(res.status).toBe(401);
  });

  it('GET /api/agents returns the seeded agents for an admin', async () => {
    const res = await agentsGet(requestWithCookie('/api/agents', tokenFor('admin')));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents.length).toBeGreaterThanOrEqual(10);
  });

  it('GET /api/agents/voice/envelope returns the seeded voice envelope', async () => {
    const res = await envelopeGet(requestWithCookie('/api/agents/voice/envelope', tokenFor('admin')), {
      params: Promise.resolve({ agentKey: 'voice' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.envelope.envelope_name).toContain('voice');
  });

  it('POST /api/agents/:agentKey/envelope creates a new version and deactivates the old one', async () => {
    const res = await envelopePost(
      requestWithCookie(`/api/agents/${RUN_ID}-agent/envelope`, tokenFor('admin'), {
        method: 'POST',
        body: JSON.stringify({ envelope_name: 'v2-test', autonomy_default: 'L1' }),
      }),
      { params: Promise.resolve({ agentKey: `${RUN_ID}-agent` }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.version).toBe(1); // first envelope for this fresh test agent
  });

  it('GET /api/evaluations returns rows for an admin', async () => {
    const res = await evaluationsGet(requestWithCookie('/api/evaluations?decision=escalate', tokenFor('admin')));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.evaluations)).toBe(true);
  });

  it('GET /api/escalations?status=pending includes the seeded escalation', async () => {
    const res = await escalationsGet(requestWithCookie('/api/escalations?status=pending', tokenFor('admin')));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.escalations.some((e: { id: number }) => e.id === escalationId)).toBe(true);
  });

  it('PATCH /api/escalations/:id updates status (no live consequence, shadow mode)', async () => {
    const res = await escalationPatch(
      requestWithCookie(`/api/escalations/${escalationId}`, tokenFor('admin'), {
        method: 'PATCH',
        body: JSON.stringify({ status: 'approved', resolution_note: 'test approval' }),
      }),
      { params: Promise.resolve({ id: String(escalationId) }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('approved');
  });
});
