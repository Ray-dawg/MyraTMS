// lib/email/__tests__/imap-poller-tender.test.ts
//
// Real-DB fixture test, same shape as imap-poller-terms.test.ts: a hand-built
// raw-MIME buffer, a fake ImapClientLike, real (unmocked) DB + Claude calls.
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { getMyraTenantId } from '@/lib/tenants/get-myra-tenant-id';
import * as tenderTerms from '@/lib/documents/tender-terms';
import { pollInbox, type ImapClientLike, type ImapFetchedMessage } from '@/lib/email/imap-poller';

// Passthrough spy: real implementation still runs where a test reaches it.
vi.mock('@/lib/documents/tender-terms', async (orig) => {
  const actual = await orig<typeof import('@/lib/documents/tender-terms')>();
  return { ...actual, extractTenderTerms: vi.fn(actual.extractTenderTerms) };
});

const seededAuthIds: number[] = [];
const seededMessageIds: string[] = [];

function makeFakeClient(messages: ImapFetchedMessage[]): ImapClientLike {
  const remaining = [...messages];
  return {
    connect: async () => {},
    mailboxOpen: async () => {},
    search: async () => remaining.map((m) => m.uid),
    fetchOne: async (uid) => remaining.find((m) => m.uid === uid) ?? false,
    messageFlagsAdd: async () => true,
    logout: async () => {},
  };
}

function rawEmailNoAttachment(subject: string, from: string, messageId: string): Buffer {
  return Buffer.from(
    `From: ${from}\r\nTo: ops@myra.dev\r\nSubject: ${subject}\r\nMessage-ID: <${messageId}>\r\nContent-Type: text/plain\r\n\r\nSee attached tender.\r\n`,
  );
}

function rawEmailWithPdf(subject: string, from: string, messageId: string): Buffer {
  const b = 'BOUNDARY123';
  const lines = [
    `From: ${from}`, 'To: ops@myra.dev', `Subject: ${subject}`, `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain', '', 'See attached tender.',
    `--${b}`, 'Content-Type: application/pdf; name="tender.pdf"',
    'Content-Disposition: attachment; filename="tender.pdf"', 'Content-Transfer-Encoding: base64', '',
    Buffer.from('not really a pdf').toString('base64'), `--${b}--`, '',
  ];
  return Buffer.from(lines.join('\r\n'));
}

describe('imap-poller — T-30 freight-tender branch (acceptance criteria 1, 2)', () => {
  afterAll(async () => {
    for (const mid of seededMessageIds) {
      await db.query(
        `DELETE FROM exceptions WHERE inbound_email_id IN (SELECT id FROM inbound_emails WHERE message_id = $1)`,
        [mid],
      );
      await db.query(`DELETE FROM inbound_emails WHERE message_id = $1`, [mid]);
    }
    for (const id of seededAuthIds) await db.query(`DELETE FROM contract_shipper_authorizations WHERE id = $1`, [id]);
  });

  beforeEach(() => { vi.mocked(tenderTerms.extractTenderTerms).mockClear(); });

  it('an unauthorized sender is quarantined with intake_status=unauthorized_sender and no extraction attempted', async () => {
    const from = `unauth-${Date.now()}@random-shipper.example.com`;
    const messageId = `t30-unauth-${Date.now()}`;
    seededMessageIds.push(messageId);
    const client = makeFakeClient([
      { uid: 1, envelope: { subject: 'Freight available — Chicago to Dallas', from: [{ address: from }] }, source: rawEmailWithPdf('Freight available — Chicago to Dallas', from, messageId) },
    ]);

    const result = await pollInbox(client);
    expect(result.processed).toBe(1);
    expect(result.quarantined).toBe(1);

    const row = await db.query<{ intake_status: string; sender_authorized: boolean | null; intake_type: string | null }>(
      `SELECT intake_status, sender_authorized, intake_type FROM inbound_emails WHERE message_id = $1`, [messageId],
    );
    expect(row.rows[0].intake_status).toBe('unauthorized_sender');
    expect(row.rows[0].intake_type).toBeNull();

    const exc = await db.query<{ id: number }>(
      `SELECT id FROM exceptions WHERE type = 'unauthorized_tender_sender' AND title LIKE $1`, [`%${from}%`],
    );
    expect(exc.rows.length).toBeGreaterThan(0);
    expect(tenderTerms.extractTenderTerms).not.toHaveBeenCalled();
  });

  it('an authorized sender with no attachment is marked freight_tender but not routed to the console (nothing to review yet)', async () => {
    const tenantId = await getMyraTenantId();
    const from = `authorized-noattach-${Date.now()}@shipper.example.com`;
    const authInsert = await db.query<{ id: number }>(
      `INSERT INTO contract_shipper_authorizations (tenant_id, shipper_email, authorized_by) VALUES ($1, $2, 'test-suite') RETURNING id`,
      [tenantId, from],
    );
    seededAuthIds.push(authInsert.rows[0].id);

    const messageId = `t30-noattach-${Date.now()}`;
    seededMessageIds.push(messageId);
    const client = makeFakeClient([
      { uid: 1, envelope: { subject: 'Got a load for you', from: [{ address: from }] }, source: rawEmailNoAttachment('Got a load for you', from, messageId) },
    ]);

    await pollInbox(client);
    const row = await db.query<{ id: number; intake_type: string | null; sender_authorized: boolean | null; intake_status: string | null }>(
      `SELECT id, intake_type, sender_authorized, intake_status FROM inbound_emails WHERE message_id = $1`, [messageId],
    );
    expect(row.rows[0].sender_authorized).toBe(true);
    expect(row.rows[0].intake_type).toBe('freight_tender');
    expect(row.rows[0].intake_status).toBeNull();

    const exc = await db.query(`SELECT 1 FROM exceptions WHERE inbound_email_id = $1`, [row.rows[0].id]);
    expect(exc.rows.length).toBe(0);
  });

  it('an authorized sender whose tender has no PDF attachment does not call extraction', async () => {
    const tenantId = await getMyraTenantId();
    const from = `authorized-nopdf-${Date.now()}@shipper.example.com`;
    const a = await db.query<{ id: number }>(
      `INSERT INTO contract_shipper_authorizations (tenant_id, shipper_email, authorized_by) VALUES ($1, $2, 'test-suite') RETURNING id`,
      [tenantId, from],
    );
    seededAuthIds.push(a.rows[0].id);
    const messageId = `t30-nopdf-${Date.now()}`;
    seededMessageIds.push(messageId);
    await pollInbox(makeFakeClient([
      { uid: 1, envelope: { subject: 'Load', from: [{ address: from }] }, source: rawEmailNoAttachment('Load', from, messageId) },
    ]));
    expect(tenderTerms.extractTenderTerms).not.toHaveBeenCalled();
  });

  it('flags intake_status=bridge_failed when the tenant has no contract_intake classification rule', async () => {
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM tenants WHERE id <> fn_myra_tenant_id() LIMIT 1`,
    );
    if (rows.length === 0) {
      console.warn('[test] skipped: no non-Myra tenant exists on this branch');
      return;
    }
    const from = `authorized-norule-${Date.now()}@shipper.example.com`;
    const a = await db.query<{ id: number }>(
      `INSERT INTO contract_shipper_authorizations (tenant_id, shipper_email, authorized_by) VALUES ($1, $2, 'test-suite') RETURNING id`,
      [rows[0].id, from],
    );
    seededAuthIds.push(a.rows[0].id);
    const messageId = `t30-norule-${Date.now()}`;
    seededMessageIds.push(messageId);
    await pollInbox(makeFakeClient([
      { uid: 1, envelope: { subject: 'Tender', from: [{ address: from }] }, source: rawEmailWithPdf('Tender', from, messageId) },
    ]));
    const row = await db.query<{ id: number; intake_status: string }>(
      `SELECT id, intake_status FROM inbound_emails WHERE message_id = $1`, [messageId],
    );
    expect(row.rows[0].intake_status).toBe('bridge_failed');
    const exc = await db.query(`SELECT 1 FROM exceptions WHERE inbound_email_id = $1`, [row.rows[0].id]);
    expect(exc.rows.length).toBe(0);
  });
});
