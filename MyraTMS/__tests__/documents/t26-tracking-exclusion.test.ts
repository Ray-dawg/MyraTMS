// __tests__/documents/t26-tracking-exclusion.test.ts
//
// Acceptance criterion 5 — pins the existing allow-list so a future change
// can't silently widen self-service to Insurance/Contract/Rate Con. The
// route itself (app/api/tracking/[token]/documents/route.ts) is NOT
// modified by this module.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, randomBytes } from 'crypto';
import { NextRequest } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { GET } from '@/app/api/tracking/[token]/documents/route';

const REF = `T26TRACK-${Date.now()}`;

describe('Public tracking page document exclusion (criterion 5)', () => {
  const tmsLoadId = `LD-${REF}`;
  const token = randomBytes(32).toString('hex'); // resolveTrackingToken() requires exactly 64 chars

  beforeAll(async () => {
    await db.query(`INSERT INTO loads (id, origin, destination, status, tenant_id) VALUES ($1, 'A', 'B', 'Delivered', 2)`, [tmsLoadId]);
    await db.query(
      `INSERT INTO tracking_tokens (id, load_id, token, tenant_id, expires_at) VALUES ($1, $2, $3, 2, NOW() + INTERVAL '30 days')`,
      [randomUUID(), tmsLoadId, token],
    );
    const types = ['BOL', 'POD', 'Invoice', 'Insurance', 'Contract', 'Rate Confirmation', 'Shipper Rate Confirmation', 'Shipper Rate Confirmation Reply'];
    for (const [idx, type] of types.entries()) {
      await db.query(
        `INSERT INTO documents (id, name, type, related_to, related_type, tenant_id) VALUES ($1, $2, $3, $4, 'Load', 2)`,
        [`DOC-${REF}-${idx}`, `${type}.pdf`, type, tmsLoadId],
      );
    }
  });

  afterAll(async () => {
    await db.query(`DELETE FROM documents WHERE related_to = $1`, [tmsLoadId]);
    await db.query(`DELETE FROM tracking_tokens WHERE load_id = $1`, [tmsLoadId]);
    await db.query(`DELETE FROM loads WHERE id = $1`, [tmsLoadId]);
  });

  it('exposes only BOL, POD, and Invoice — never Insurance, Contract, or any Rate Con variant', async () => {
    const req = new NextRequest(`http://x/api/tracking/${token}/documents`);
    const res = await GET(req, { params: Promise.resolve({ token }) });
    const body = await res.json();
    const returnedTypes = body.documents.map((d: { type: string }) => d.type).sort();
    expect(returnedTypes).toEqual(['BOL', 'Invoice', 'POD']);
  });
});
