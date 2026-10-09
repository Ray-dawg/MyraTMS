// T-30 Task 10 — integration test for the tenant-scoped pending-tenders list.
// Hits the real Neon branch (same discipline as the rest of the T-30 suite);
// fixtures are created per-test and removed in afterEach, with every id
// variable reset so one test's cleanup can never re-delete another's row
// (the exact bug found in Task 7 of this plan).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { GET } from '@/app/api/contract-intake/pending/route';
import { createToken } from '@/lib/auth';
import { bridgeToExceptions } from '@/lib/exceptions/bridge';
import { getMyraTenantId } from '@/lib/tenants/get-myra-tenant-id';

function tokenFor(tenantId: number): string {
  return createToken({
    userId: 'u', email: 'e@myra.dev', role: 'admin', firstName: 'T', lastName: 'U',
    tenantId, tenantIds: [tenantId], isSuperAdmin: false,
  });
}

function requestWithToken(token: string): NextRequest {
  const headers = new Headers();
  headers.set('cookie', `auth-token=${token}`);
  return new NextRequest('http://localhost/api/contract-intake/pending', { headers });
}

describe('GET /api/contract-intake/pending', () => {
  let tenantId: number | null = null;
  let inboundEmailId: number | null = null;
  // exceptions.id is a uuid — never coerce it to a number.
  let exceptionId: string | null = null;
  let title: string | null = null;
  // Second fixture, used only by the LEFT JOIN case.
  let nullEmailExceptionId: string | null = null;

  beforeEach(async () => {
    tenantId = await getMyraTenantId();
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    title = `T-30 test tender ${unique}`;

    const inserted = await db.query<{ id: number }>(
      `INSERT INTO inbound_emails (message_id, from_address, subject, received_at, quarantined, intake_type, intake_status)
       VALUES ($1, 'shipper@example.com', 'Tender', NOW(), true, 'freight_tender', 'pending_review')
       RETURNING id`,
      [`t30-pending-${unique}`],
    );
    inboundEmailId = Number(inserted.rows[0].id);

    // bridgeToExceptions returns false whenever no active
    // exception_classification_rules row matches (tenant, source_module) —
    // asserting it here keeps the downstream assertions from passing
    // vacuously against an exception that was never written.
    const wrote = await bridgeToExceptions({
      tenantId,
      sourceModule: 'contract_intake',
      exceptionType: 'tender_pending_approval',
      title,
      description: 'Parsed tender awaiting operator approval',
      context: {},
      pipelineLoadId: null,
      loadId: null,
      carrierId: null,
      inboundEmailId,
    });
    expect(wrote).toBe(true);

    const excRow = await db.query<{ id: string }>(
      `SELECT id FROM exceptions WHERE inbound_email_id = $1`,
      [inboundEmailId],
    );
    expect(excRow.rows).toHaveLength(1);
    exceptionId = excRow.rows[0].id;
  });

  afterEach(async () => {
    if (nullEmailExceptionId) await db.query(`DELETE FROM exceptions WHERE id = $1`, [nullEmailExceptionId]);
    if (exceptionId) await db.query(`DELETE FROM exceptions WHERE id = $1`, [exceptionId]);
    if (inboundEmailId) await db.query(`DELETE FROM inbound_emails WHERE id = $1`, [inboundEmailId]);
    nullEmailExceptionId = null;
    exceptionId = null;
    inboundEmailId = null;
    tenantId = null;
    title = null;
  });

  it("lists this tenant's pending contract-intake tenders with the joined email detail", async () => {
    const res = await GET(requestWithToken(tokenFor(tenantId!)));
    expect(res.status).toBe(200);
    const body = await res.json();

    const row = body.pending.find((p: { id: string }) => p.id === exceptionId);
    expect(row).toBeDefined();
    expect(row.title).toBe(title);
    expect(row.detail).toBe('Parsed tender awaiting operator approval');
    expect(Number(row.inbound_email_id)).toBe(inboundEmailId);
    expect(row.from_address).toBe('shipper@example.com');
    expect(row.intake_status).toBe('pending_review');
  });

  it('still lists a tender that an operator has merely acknowledged', async () => {
    await db.query(
      `UPDATE exceptions SET status = 'acknowledged', acknowledged_at = NOW() WHERE id = $1`,
      [exceptionId],
    );
    const res = await GET(requestWithToken(tokenFor(tenantId!)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pending.some((p: { id: string }) => p.id === exceptionId)).toBe(true);
  });

  it('drops a tender once it is resolved', async () => {
    await db.query(
      `UPDATE exceptions SET status = 'resolved', resolved_at = NOW() WHERE id = $1`,
      [exceptionId],
    );
    const res = await GET(requestWithToken(tokenFor(tenantId!)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pending.some((p: { id: string }) => p.id === exceptionId)).toBe(false);
  });

  it('does not leak the tender to another tenant', async () => {
    const other = await db.query<{ id: string }>(
      `SELECT id FROM tenants WHERE id <> $1 ORDER BY id LIMIT 1`,
      [tenantId],
    );
    expect(other.rows).toHaveLength(1);
    const otherTenantId = Number(other.rows[0].id);

    const res = await GET(requestWithToken(tokenFor(otherTenantId)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pending.some((p: { id: string }) => p.id === exceptionId)).toBe(false);
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await GET(new NextRequest('http://localhost/api/contract-intake/pending'));
    expect(res.status).toBe(401);
  });

  // The LEFT JOIN is a deliberate departure from the plan's INNER JOIN,
  // specifically so a contract_intake exception with no inbound_email_id can
  // never be hidden forever from the list whose whole job is visibility.
  // Without this case, reverting to an INNER JOIN keeps the suite green.
  it('still lists a contract_intake exception that has no inbound_email_id', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const orphanTitle = `T-30 test tender without email ${unique}`;
    const wrote = await bridgeToExceptions({
      tenantId: tenantId!,
      sourceModule: 'contract_intake',
      exceptionType: 'tender_pending_approval',
      title: orphanTitle,
      description: 'Signal with no inbound_emails row behind it',
      context: {},
      pipelineLoadId: null,
      loadId: null,
      carrierId: null,
      inboundEmailId: null,
    });
    expect(wrote).toBe(true);
    const orphan = await db.query<{ id: string }>(
      `SELECT id FROM exceptions WHERE title = $1 AND inbound_email_id IS NULL`,
      [orphanTitle],
    );
    expect(orphan.rows).toHaveLength(1);
    nullEmailExceptionId = orphan.rows[0].id;

    const res = await GET(requestWithToken(tokenFor(tenantId!)));
    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.pending.find((p: { id: string }) => p.id === nullEmailExceptionId);
    expect(row).toBeDefined();
    expect(row.inbound_email_id).toBeNull();
    expect(row.from_address).toBeNull();
    expect(row.intake_status).toBeNull();
  });
});
