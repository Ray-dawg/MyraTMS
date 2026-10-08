/**
 * T-30 Task 9 — the approve/reject branch on PATCH /api/exceptions/:id, the
 * ONLY code path in the module that creates a pipeline_loads row.
 *
 * Auth pattern copied in shape from __tests__/exceptions/tenant-onboarding-resolve.test.ts:
 * a real createToken() + 'auth-token' cookie on a real NextRequest, with no
 * mocking of getCurrentUser/requireTenantContext. With no x-myra-tenant-*
 * headers present, requireTenantContext() falls back to getCurrentUser() and
 * reads tenantId straight off the JWT (lib/auth.ts).
 *
 * The tenant is resolved via getMyraTenantId(), never hardcoded: tenant id=1
 * is `_system`, id=2 is `myra`, and migration 059 seeds the contract_intake
 * classification rule against fn_myra_tenant_id() only. The plan's own
 * `SELECT id FROM tenants LIMIT 1` would have picked `_system`, found no
 * matching rule, and made every assertion below vacuous — hence the explicit
 * assertion that bridgeToExceptions() returned true before each scenario runs.
 *
 * Note `exceptions.id` is a **uuid**, not an integer (the plan's test sketch
 * typed it `number`); it is kept as a string throughout.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { PATCH } from '@/app/api/exceptions/[id]/route';
import { NextRequest } from 'next/server';
import { createToken } from '@/lib/auth';
import { bridgeToExceptions } from '@/lib/exceptions/bridge';
import { getMyraTenantId } from '@/lib/tenants/get-myra-tenant-id';

const COMPLETE_TENDER = {
  originCity: 'Chicago', originState: 'IL', originCountry: 'US',
  destinationCity: 'Dallas', destinationState: 'TX', destinationCountry: 'US',
  equipmentType: 'Dry Van', rate: 3000, rateCurrency: 'USD', pickupDate: '2026-09-15',
  commodity: 'General Freight', weightLbs: 20000,
};

function tenantToken(tenantId: number): string {
  return createToken({
    userId: 'test-user', email: 'test@myra.dev', role: 'admin',
    firstName: 'Test', lastName: 'User', tenantId, tenantIds: [tenantId],
    isSuperAdmin: true,
  });
}

function patch(exceptionId: string, tenantId: number, body: Record<string, unknown>) {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('cookie', `auth-token=${tenantToken(tenantId)}`);
  const req = new NextRequest(`http://localhost/api/exceptions/${exceptionId}`, {
    method: 'PATCH', body: JSON.stringify(body), headers,
  });
  return PATCH(req, { params: Promise.resolve({ id: String(exceptionId) }) });
}

async function seedInboundEmail(): Promise<number> {
  const messageId = `t30-resolve-${Date.now()}-${Math.random()}`;
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO inbound_emails (
       message_id, from_address, subject, received_at, quarantined,
       intake_type, sender_authorized, intake_status
     ) VALUES ($1, 'shipper@example.com', 'Freight tender', NOW(), true, 'freight_tender', true, 'pending_review')
     RETURNING id`,
    [messageId],
  );
  return Number(rows[0].id);
}

/**
 * Creates the fixture exception exactly the way lib/email/imap-poller.ts does:
 * bridgeToExceptions() with sourceModule 'contract_intake'. The title carries
 * the email id because the bridge dedups on type+title when there is no
 * load/pipeline-load/carrier link.
 */
async function seedTenderException(tenantId: number, inboundEmailId: number): Promise<string> {
  const bridged = await bridgeToExceptions({
    tenantId,
    sourceModule: 'contract_intake',
    exceptionType: 'tender_pending_approval',
    title: `New tender ready — approve to inject [email #${inboundEmailId}]`,
    description: 'T-30 task 9 fixture tender.',
    context: {},
    pipelineLoadId: null,
    loadId: null,
    carrierId: null,
    inboundEmailId,
  });
  // False means no active exception_classification_rules row matched and the
  // signal was dropped — every assertion downstream would then be vacuous.
  expect(bridged).toBe(true);

  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM exceptions WHERE inbound_email_id = $1 AND tenant_id = $2`,
    [inboundEmailId, tenantId],
  );
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

describe('PATCH /api/exceptions/:id — T-30 contract_intake tender approve/reject', () => {
  let tenantId: number;
  let inboundEmailId: number | undefined;
  let exceptionId: string | undefined;

  afterEach(async () => {
    // FK order: inbound_emails.created_pipeline_load_id references
    // pipeline_loads, and exceptions.inbound_email_id references inbound_emails.
    if (inboundEmailId) {
      await db.query(`UPDATE inbound_emails SET created_pipeline_load_id = NULL WHERE id = $1`, [inboundEmailId]);
      await db.query(`DELETE FROM pipeline_loads WHERE load_id LIKE $1`, [`email_tender-${inboundEmailId}-%`]);
    }
    if (exceptionId) await db.query(`DELETE FROM exceptions WHERE id = $1`, [exceptionId]);
    if (inboundEmailId) await db.query(`DELETE FROM inbound_emails WHERE id = $1`, [inboundEmailId]);
    // `events` rows written by the route's T-17 logging block are left in
    // place — no cleanup convention exists for that append-only table.
    inboundEmailId = undefined;
    exceptionId = undefined;
  });

  it('reject flips intake_status to rejected and creates zero pipeline_loads rows (acceptance criterion 5)', async () => {
    tenantId = await getMyraTenantId();
    inboundEmailId = await seedInboundEmail();
    exceptionId = await seedTenderException(tenantId, inboundEmailId);

    const res = await patch(exceptionId, tenantId, { action: 'resolve', decision: 'reject' });
    expect(res.status).toBe(200);

    const { rows: emailRows } = await db.query<{ intake_status: string; created_pipeline_load_id: number | null }>(
      `SELECT intake_status, created_pipeline_load_id FROM inbound_emails WHERE id = $1`, [inboundEmailId],
    );
    expect(emailRows[0].intake_status).toBe('rejected');
    expect(emailRows[0].created_pipeline_load_id).toBeNull();

    const { rows: countRows } = await db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM pipeline_loads WHERE load_id LIKE $1`, [`email_tender-${inboundEmailId}-%`],
    );
    expect(countRows[0].c).toBe(0);

    const { rows: excRows } = await db.query<{ status: string }>(
      `SELECT status FROM exceptions WHERE id = $1`, [exceptionId],
    );
    expect(excRows[0].status).toBe('resolved');
  });

  it('approve creates exactly one pipeline_loads row at qualified with source_type=email_tender', async () => {
    tenantId = await getMyraTenantId();
    inboundEmailId = await seedInboundEmail();
    exceptionId = await seedTenderException(tenantId, inboundEmailId);

    const res = await patch(exceptionId, tenantId, {
      action: 'resolve', decision: 'approve', tender: COMPLETE_TENDER,
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.createdPipelineLoadId).toBeTruthy();

    const { rows: loadRows } = await db.query<{
      id: number; stage: string; source_type: string; origin_city: string;
      destination_city: string; posted_rate: string; load_board_source: string; created_by: string;
    }>(
      `SELECT id, stage, source_type, origin_city, destination_city, posted_rate, load_board_source, created_by
         FROM pipeline_loads WHERE load_id LIKE $1`,
      [`email_tender-${inboundEmailId}-%`],
    );
    expect(loadRows).toHaveLength(1);
    expect(loadRows[0].stage).toBe('qualified');
    expect(loadRows[0].source_type).toBe('email_tender');
    expect(loadRows[0].origin_city).toBe('Chicago');
    expect(loadRows[0].destination_city).toBe('Dallas');
    expect(Number(loadRows[0].posted_rate)).toBe(3000);
    expect(loadRows[0].load_board_source).toBe('email_tender');
    expect(loadRows[0].created_by).toBe('contract-intake');
    expect(Number(payload.createdPipelineLoadId)).toBe(Number(loadRows[0].id));

    const { rows: emailRows } = await db.query<{ intake_status: string; created_pipeline_load_id: number | null }>(
      `SELECT intake_status, created_pipeline_load_id FROM inbound_emails WHERE id = $1`, [inboundEmailId],
    );
    expect(emailRows[0].intake_status).toBe('approved');
    expect(Number(emailRows[0].created_pipeline_load_id)).toBe(Number(loadRows[0].id));
  });

  it('approve with no tender is a 400 that leaves the exception active and the email pending', async () => {
    tenantId = await getMyraTenantId();
    inboundEmailId = await seedInboundEmail();
    exceptionId = await seedTenderException(tenantId, inboundEmailId);

    const res = await patch(exceptionId, tenantId, { action: 'resolve', decision: 'approve' });
    expect(res.status).toBe(400);

    const { rows: excRows } = await db.query<{ status: string }>(
      `SELECT status FROM exceptions WHERE id = $1`, [exceptionId],
    );
    expect(excRows[0].status).toBe('active');

    const { rows: emailRows } = await db.query<{ intake_status: string }>(
      `SELECT intake_status FROM inbound_emails WHERE id = $1`, [inboundEmailId],
    );
    expect(emailRows[0].intake_status).toBe('pending_review');

    const { rows: countRows } = await db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM pipeline_loads WHERE load_id LIKE $1`, [`email_tender-${inboundEmailId}-%`],
    );
    expect(countRows[0].c).toBe(0);
  });

  it('a second approve is a 409 and still leaves exactly one pipeline_loads row', async () => {
    tenantId = await getMyraTenantId();
    inboundEmailId = await seedInboundEmail();
    exceptionId = await seedTenderException(tenantId, inboundEmailId);

    const first = await patch(exceptionId, tenantId, {
      action: 'resolve', decision: 'approve', tender: COMPLETE_TENDER,
    });
    expect(first.status).toBe(200);

    const second = await patch(exceptionId, tenantId, {
      action: 'resolve', decision: 'approve', tender: COMPLETE_TENDER,
    });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe('Tender already processed');

    const { rows: countRows } = await db.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM pipeline_loads WHERE load_id LIKE $1`, [`email_tender-${inboundEmailId}-%`],
    );
    expect(countRows[0].c).toBe(1);
  });
});
