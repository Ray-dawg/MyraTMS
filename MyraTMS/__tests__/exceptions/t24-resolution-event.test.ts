// __tests__/exceptions/t24-resolution-event.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(() => ({ userId: 'test-user', email: 't@x.com', role: 'admin', tenantId: 2, tenantIds: [2] })),
  requireTenantContext: vi.fn(() => ({ tenantId: 2, role: 'admin', userId: 'test-user', isSuperAdmin: false })),
}));

import { PATCH } from '@/app/api/exceptions/[id]/route';

const REFERENCE = `T24RESOLVE-${Date.now()}`;

describe('PATCH /api/exceptions/:id — additive resolution-event logging', () => {
  let excId: string;

  beforeAll(async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO exceptions (load_id, carrier_id, type, severity, title, detail, tenant_id)
       VALUES (NULL, NULL, $1, 'low', 'Test exception', 'detail', 2) RETURNING id`,
      [REFERENCE],
    );
    excId = rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM events WHERE derived_from_table = 'exceptions' AND payload->>'exceptionId' = $1`, [excId]);
    await db.query(`DELETE FROM exceptions WHERE id = $1`, [excId]);
  });

  it('resolve action returns the exact same response shape as before, and additionally logs a T-17 event', async () => {
    const req = new NextRequest(`http://x/api/exceptions/${excId}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'resolve' }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: excId }) });
    const body = await res.json();
    expect(body.status).toBe('resolved');
    expect(body.id).toBe(excId);

    const events = await db.query(
      `SELECT event_type, entity_type, payload FROM events WHERE derived_from_table = 'exceptions' AND payload->>'exceptionId' = $1`,
      [excId],
    );
    expect(events.rows.length).toBe(1);
    expect(events.rows[0].event_type).toBe('exception.resolved');
  });
});
