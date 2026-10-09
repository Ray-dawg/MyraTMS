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
 * Tenants are resolved by slug — getMyraTenantId() for the owning tenant and a
 * `slug = '_system'` lookup for the cross-tenant attacker — never hardcoded:
 * tenant id=1 is `_system`, id=2 is `myra`, and migration 059 seeds the
 * contract_intake classification rule against fn_myra_tenant_id() only. The
 * plan's own `SELECT id FROM tenants LIMIT 1` would have picked `_system`,
 * found no matching rule, and made every assertion below vacuous — hence the
 * explicit assertion that bridgeToExceptions() returned true before each
 * scenario runs.
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

/** A valid tenant that is NOT the one the fixture belongs to. Resolved by slug. */
async function otherTenantId(): Promise<number> {
  const { rows } = await db.query<{ id: string }>(`SELECT id FROM tenants WHERE slug = '_system'`);
  expect(rows).toHaveLength(1);
  return Number(rows[0].id);
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

async function emailState(inboundEmailId: number) {
  const { rows } = await db.query<{ intake_status: string; created_pipeline_load_id: number | null }>(
    `SELECT intake_status, created_pipeline_load_id FROM inbound_emails WHERE id = $1`, [inboundEmailId],
  );
  return rows[0];
}

async function exceptionStatus(exceptionId: string): Promise<string> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM exceptions WHERE id = $1`, [exceptionId],
  );
  return rows[0].status;
}

async function tenderLoadCount(inboundEmailId: number): Promise<number> {
  const { rows } = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM pipeline_loads WHERE load_id LIKE $1`,
    [`email_tender-${inboundEmailId}-%`],
  );
  return rows[0].c;
}

describe('PATCH /api/exceptions/:id — T-30 contract_intake tender approve/reject', () => {
  let tenantId: number;
  let inboundEmailId: number | undefined;
  let exceptionId: string | undefined;

  afterEach(async () => {
    // Everything is deleted by inbound_email_id, never by the captured
    // exceptionId: seedTenderException() can throw AFTER the bridge has
    // already inserted the exception, and a cleanup keyed on the captured id
    // would then skip the exception delete and FK-violate on the
    // inbound_emails delete, leaking rows into every later test.
    //
    // FK order: inbound_emails.created_pipeline_load_id references
    // pipeline_loads, and exceptions.inbound_email_id references inbound_emails.
    if (inboundEmailId) {
      await db.query(`UPDATE inbound_emails SET created_pipeline_load_id = NULL WHERE id = $1`, [inboundEmailId]);
      await db.query(`DELETE FROM exceptions WHERE inbound_email_id = $1`, [inboundEmailId]);
      await db.query(`DELETE FROM pipeline_loads WHERE load_id LIKE $1`, [`email_tender-${inboundEmailId}-%`]);
      await db.query(`DELETE FROM inbound_emails WHERE id = $1`, [inboundEmailId]);
    }
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
    // createdPipelineLoadId is keyed off approve; a reject must not carry it
    // at all, not even as null.
    expect(await res.json()).not.toHaveProperty('createdPipelineLoadId');

    const email = await emailState(inboundEmailId);
    expect(email.intake_status).toBe('rejected');
    expect(email.created_pipeline_load_id).toBeNull();
    expect(await tenderLoadCount(inboundEmailId)).toBe(0);
    expect(await exceptionStatus(exceptionId)).toBe('resolved');
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

    const email = await emailState(inboundEmailId);
    expect(email.intake_status).toBe('approved');
    expect(Number(email.created_pipeline_load_id)).toBe(Number(loadRows[0].id));
  });

  it('another tenant gets a 404 and changes nothing — this guard is the whole tenant boundary while RLS is off', async () => {
    tenantId = await getMyraTenantId();
    inboundEmailId = await seedInboundEmail();
    exceptionId = await seedTenderException(tenantId, inboundEmailId);

    const attacker = await otherTenantId();
    expect(attacker).not.toBe(tenantId);

    const res = await patch(exceptionId, attacker, {
      action: 'resolve', decision: 'approve', tender: COMPLETE_TENDER,
    });
    expect(res.status).toBe(404);

    expect((await emailState(inboundEmailId)).intake_status).toBe('pending_review');
    expect(await exceptionStatus(exceptionId)).toBe('active');
    expect(await tenderLoadCount(inboundEmailId)).toBe(0);
  });

  it('a missing or unrecognized decision is a 400 that changes nothing', async () => {
    tenantId = await getMyraTenantId();
    inboundEmailId = await seedInboundEmail();
    exceptionId = await seedTenderException(tenantId, inboundEmailId);

    const missing = await patch(exceptionId, tenantId, { action: 'resolve' });
    expect(missing.status).toBe(400);

    const bogus = await patch(exceptionId, tenantId, { action: 'resolve', decision: 'maybe' });
    expect(bogus.status).toBe(400);

    expect((await emailState(inboundEmailId)).intake_status).toBe('pending_review');
    expect(await exceptionStatus(exceptionId)).toBe('active');
    expect(await tenderLoadCount(inboundEmailId)).toBe(0);
  });

  it('approve with no tender is a 400 that leaves the exception active and the email pending', async () => {
    tenantId = await getMyraTenantId();
    inboundEmailId = await seedInboundEmail();
    exceptionId = await seedTenderException(tenantId, inboundEmailId);

    const res = await patch(exceptionId, tenantId, { action: 'resolve', decision: 'approve' });
    expect(res.status).toBe(400);

    expect(await exceptionStatus(exceptionId)).toBe('active');
    expect((await emailState(inboundEmailId)).intake_status).toBe('pending_review');
    expect(await tenderLoadCount(inboundEmailId)).toBe(0);
  });

  it('rejects tender field values the target columns cannot hold, rather than 500ing', async () => {
    tenantId = await getMyraTenantId();
    inboundEmailId = await seedInboundEmail();
    exceptionId = await seedTenderException(tenantId, inboundEmailId);

    // Each of these reached Postgres as a cast/width/range error before the
    // validation was tightened: origin_country is VARCHAR(2),
    // posted_rate_currency is VARCHAR(3), weight_lbs is INTEGER,
    // posted_rate is NUMERIC(10,2), and pickup_date is TIMESTAMP NOT NULL.
    //
    // The three date cases are the ones Date.parse() alone let through:
    // '2026-02-30' parses in V8 and silently rolls to 2026-03-02, '1' parses
    // as the year 2001, and '2026-9-5' is not the shape the extractor emits.
    // Every rejection must also NAME the field — an operator who gets a bare
    // 'invalid tender' has to open a ticket to find out which of twelve
    // fields to fix.
    const bad: Array<{ field: string; tender: Record<string, unknown> }> = [
      { field: 'originCountry', tender: { ...COMPLETE_TENDER, originCountry: 'USA' } },
      { field: 'destinationCountry', tender: { ...COMPLETE_TENDER, destinationCountry: 'MX' } },
      { field: 'rateCurrency', tender: { ...COMPLETE_TENDER, rateCurrency: 'DOLLARS' } },
      { field: 'weightLbs', tender: { ...COMPLETE_TENDER, weightLbs: 20000.5 } },
      { field: 'weightLbs', tender: { ...COMPLETE_TENDER, weightLbs: 3000000000 } },
      { field: 'pickupDate', tender: { ...COMPLETE_TENDER, pickupDate: '2026-13-45' } },
      { field: 'pickupDate', tender: { ...COMPLETE_TENDER, pickupDate: '2026-02-30' } },
      { field: 'pickupDate', tender: { ...COMPLETE_TENDER, pickupDate: '1' } },
      { field: 'pickupDate', tender: { ...COMPLETE_TENDER, pickupDate: '2026-9-5' } },
      { field: 'pickupDate', tender: { ...COMPLETE_TENDER, pickupDate: '0000-01-01' } },
      { field: 'pickupDate', tender: { ...COMPLETE_TENDER, pickupDate: '10/08/2026' } },
      { field: 'pickupDate', tender: { ...COMPLETE_TENDER, pickupDate: 'October 8, 2026' } },
      { field: 'equipmentType', tender: { ...COMPLETE_TENDER, equipmentType: 'x'.repeat(51) } },
      { field: 'originState', tender: { ...COMPLETE_TENDER, originState: 'x'.repeat(11) } },
      { field: 'originCity', tender: { ...COMPLETE_TENDER, originCity: '   ' } },
      { field: 'commodity', tender: { ...COMPLETE_TENDER, commodity: 'x'.repeat(201) } },
      { field: 'rate', tender: { ...COMPLETE_TENDER, rate: -1 } },
      { field: 'rate', tender: { ...COMPLETE_TENDER, rate: 1e8 } },
      { field: 'rate', tender: { ...COMPLETE_TENDER, rate: 1e-7 } },
      { field: 'rate', tender: { ...COMPLETE_TENDER, rate: '3000' } },
    ];
    for (const { field, tender } of bad) {
      const res = await patch(exceptionId, tenantId, { action: 'resolve', decision: 'approve', tender });
      const label = JSON.stringify(tender[field] ?? null);
      expect(res.status, `${field}=${label}`).toBe(400);
      expect((await res.json()).error, `${field}=${label}`).toContain(`tender.${field} `);
    }

    expect(await exceptionStatus(exceptionId)).toBe('active');
    expect((await emailState(inboundEmailId)).intake_status).toBe('pending_review');
    expect(await tenderLoadCount(inboundEmailId)).toBe(0);
  });

  // extractTenderTerms() does no normalization, so these are realistic
  // extractor outputs that stored fine before the date-shape check existed.
  // Rejecting them would turn an authorized tender into a 400.
  it.each([
    '2026-10-08T00:00:00',
    '2026-10-08T00:00:00Z',
    '2026-10-08T00:00:00.000+00:00',
    '2026-10-08 00:00:00',
    ' 2026-10-08 ',
  ])('accepts pickupDate %j and stores the bare date 2026-10-08', async (pickupDate) => {
    tenantId = await getMyraTenantId();
    inboundEmailId = await seedInboundEmail();
    exceptionId = await seedTenderException(tenantId, inboundEmailId);

    const res = await patch(exceptionId, tenantId, {
      action: 'resolve', decision: 'approve', tender: { ...COMPLETE_TENDER, pickupDate },
    });
    expect(res.status).toBe(200);

    const { rows } = await db.query<{ d: string }>(
      `SELECT to_char(pickup_date, 'YYYY-MM-DD HH24:MI:SS') AS d FROM pipeline_loads WHERE load_id LIKE $1`,
      [`email_tender-${inboundEmailId}-%`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].d).toBe('2026-10-08 00:00:00');
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

    expect(await tenderLoadCount(inboundEmailId)).toBe(1);
  });

  it('recovers a wedged tender: claim committed, resolve did not — retry resolves without a second load', async () => {
    tenantId = await getMyraTenantId();
    inboundEmailId = await seedInboundEmail();
    exceptionId = await seedTenderException(tenantId, inboundEmailId);

    const first = await patch(exceptionId, tenantId, {
      action: 'resolve', decision: 'approve', tender: COMPLETE_TENDER,
    });
    expect(first.status).toBe(200);
    const originalLoadId = Number((await first.json()).createdPipelineLoadId);

    // Reproduce the exact post-wedge database state without touching the
    // route: the claim + INSERT transaction committed, then the SECOND
    // transaction (the base resolve UPDATE) failed, so the exception is
    // still active while the email is already claimed. Rewinding the
    // exception is the only way to reach that state — the two writes are in
    // separate transactions by construction.
    await db.query(
      `UPDATE exceptions SET status = 'active', resolved_at = NULL WHERE id = $1`,
      [exceptionId],
    );

    const retry = await patch(exceptionId, tenantId, {
      action: 'resolve', decision: 'approve', tender: COMPLETE_TENDER,
    });
    expect(retry.status).toBe(200);
    // The already-created load is reported back, not a new one.
    expect(Number((await retry.json()).createdPipelineLoadId)).toBe(originalLoadId);
    expect(await tenderLoadCount(inboundEmailId)).toBe(1);
    expect(await exceptionStatus(exceptionId)).toBe('resolved');

    // And once resolved, a further submit is a plain 409 again.
    const third = await patch(exceptionId, tenantId, {
      action: 'resolve', decision: 'approve', tender: COMPLETE_TENDER,
    });
    expect(third.status).toBe(409);
  });

  it('recovers a wedge on an ACKNOWLEDGED exception too — the disqualifying state is only resolved', async () => {
    tenantId = await getMyraTenantId();
    inboundEmailId = await seedInboundEmail();
    exceptionId = await seedTenderException(tenantId, inboundEmailId);

    // acknowledge is supported on every exception type, including this one,
    // and the base resolve UPDATE has no status predicate — so an operator
    // can legitimately acknowledge a tender and approve it afterwards.
    const ack = await patch(exceptionId, tenantId, { action: 'acknowledge' });
    expect(ack.status).toBe(200);
    expect(await exceptionStatus(exceptionId)).toBe('acknowledged');

    const first = await patch(exceptionId, tenantId, {
      action: 'resolve', decision: 'approve', tender: COMPLETE_TENDER,
    });
    expect(first.status).toBe(200);
    const originalLoadId = Number((await first.json()).createdPipelineLoadId);

    // Rewind to the acknowledged-and-wedged state: claim + INSERT committed,
    // the resolve transaction did not. An earlier revision of the recovery
    // allowlisted status='active' and returned 409 here, leaving the
    // exception permanently unresolvable.
    await db.query(
      `UPDATE exceptions SET status = 'acknowledged', resolved_at = NULL WHERE id = $1`,
      [exceptionId],
    );

    const retry = await patch(exceptionId, tenantId, {
      action: 'resolve', decision: 'approve', tender: COMPLETE_TENDER,
    });
    expect(retry.status).toBe(200);
    expect(Number((await retry.json()).createdPipelineLoadId)).toBe(originalLoadId);
    expect(await tenderLoadCount(inboundEmailId)).toBe(1);
    expect(await exceptionStatus(exceptionId)).toBe('resolved');
  });

  it('does not treat a decision flip as a wedge: reject after an unresolved approve stays a 409', async () => {
    tenantId = await getMyraTenantId();
    inboundEmailId = await seedInboundEmail();
    exceptionId = await seedTenderException(tenantId, inboundEmailId);

    const first = await patch(exceptionId, tenantId, {
      action: 'resolve', decision: 'approve', tender: COMPLETE_TENDER,
    });
    expect(first.status).toBe(200);
    await db.query(
      `UPDATE exceptions SET status = 'active', resolved_at = NULL WHERE id = $1`,
      [exceptionId],
    );

    // Stored intake_status is 'approved'; this request asks to reject. That
    // is not a resumed wedge, so it must stay a 409 and leave the approved
    // state alone.
    const flip = await patch(exceptionId, tenantId, { action: 'resolve', decision: 'reject' });
    expect(flip.status).toBe(409);
    expect((await emailState(inboundEmailId)).intake_status).toBe('approved');
    expect(await exceptionStatus(exceptionId)).toBe('active');
    expect(await tenderLoadCount(inboundEmailId)).toBe(1);
  });
});
