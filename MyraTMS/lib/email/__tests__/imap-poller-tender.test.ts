// lib/email/__tests__/imap-poller-tender.test.ts
//
// Real-DB fixture test, same shape as imap-poller-terms.test.ts: a hand-built
// raw-MIME buffer, a fake ImapClientLike, real (unmocked) DB + Claude calls.
import { describe, it, expect, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { getMyraTenantId } from '@/lib/tenants/get-myra-tenant-id';
import { pollInbox, type ImapClientLike, type ImapFetchedMessage } from '@/lib/email/imap-poller';

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

  it('an unauthorized sender is quarantined with intake_status=unauthorized_sender and no extraction attempted', async () => {
    const from = `unauth-${Date.now()}@random-shipper.example.com`;
    const messageId = `t30-unauth-${Date.now()}`;
    seededMessageIds.push(messageId);
    const client = makeFakeClient([
      { uid: 1, envelope: { subject: 'Freight available — Chicago to Dallas', from: [{ address: from }] }, source: rawEmailNoAttachment('Freight available — Chicago to Dallas', from, messageId) },
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
});
