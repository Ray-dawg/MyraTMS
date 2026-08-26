/**
 * lib/email/imap-poller.ts integration test (E2-04 M4).
 * Uses a fake ImapClientLike (no real IMAP connection) with real raw RFC822
 * message sources, matching this codebase's established convention for
 * I/O-adjacent logic (dispatch-gate.test.ts mocks @vercel/blob's put() the
 * same way -- test the logic, not the third-party wire protocol).
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { withTenant } from '@/lib/db/tenant-context';
import { LEGACY_DEFAULT_TENANT_ID } from '@/lib/auth';
import { pollInbox, type ImapClientLike, type ImapFetchedMessage } from '@/lib/email/imap-poller';

vi.mock('@vercel/blob', () => ({
  put: vi.fn(async (filename: string) => ({ url: `https://blob.test/${filename}` })),
}));

const RUN_ID = Date.now();
const seededPipelineLoadIds: number[] = [];
const seededTmsLoadIds: string[] = [];
const seededCarrierIds: string[] = [];
const seededMessageIds: string[] = [];
const seededDocumentLoadIds: string[] = [];

function rawEmail(opts: { from: string; subject: string; text: string; messageId: string; attachment?: { filename: string; content: string } }): Buffer {
  const boundary = '----test-boundary';
  const lines = [
    `From: ${opts.from}`,
    `To: dispatch@myralogistics.com`,
    `Subject: ${opts.subject}`,
    `Message-ID: <${opts.messageId}>`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
  ];
  if (!opts.attachment) {
    lines.push(`Content-Type: text/plain; charset=utf-8`, '', opts.text);
  } else {
    lines.push(
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      '',
      opts.text,
      `--${boundary}`,
      `Content-Type: application/pdf`,
      `Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
      `Content-Transfer-Encoding: base64`,
      '',
      Buffer.from(opts.attachment.content).toString('base64'),
      `--${boundary}--`,
    );
  }
  return Buffer.from(lines.join('\r\n'));
}

/** Minimal fake ImapClientLike backed by an in-memory message list. */
function makeFakeClient(messages: Array<{ uid: number; source: Buffer; subject: string; fromAddress: string }>): ImapClientLike {
  return {
    connect: vi.fn(async () => {}),
    mailboxOpen: vi.fn(async () => {}),
    search: vi.fn(async () => messages.map((m) => m.uid)),
    fetchOne: vi.fn(async (uid: number): Promise<ImapFetchedMessage | false> => {
      const m = messages.find((x) => x.uid === uid);
      if (!m) return false;
      return {
        uid: m.uid,
        envelope: { subject: m.subject, from: [{ address: m.fromAddress }] },
        source: m.source,
      };
    }),
    messageFlagsAdd: vi.fn(async () => true),
    logout: vi.fn(async () => {}),
  };
}

async function seedPipelineLoad(opts: { loadId: string; shipperEmail: string }): Promise<number> {
  const ins = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, origin_city, origin_state, origin_country,
       destination_city, destination_state, destination_country,
       pickup_date, delivery_date, equipment_type, weight_lbs,
       shipper_company, shipper_email, shipper_phone, stage
     ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
       NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
       'IMAP Test Co', $2, '+17055550000', 'awaiting_shipper_confirmation'
     ) RETURNING id`,
    [opts.loadId, opts.shipperEmail],
  );
  seededPipelineLoadIds.push(ins.rows[0].id);
  return ins.rows[0].id;
}

async function seedCarrierAndTmsLoad(opts: {
  carrierId: string;
  contactEmail: string;
  tmsLoadId: string;
  pipelineLoadId: number;
  status: string;
}): Promise<void> {
  seededCarrierIds.push(opts.carrierId);
  await db.query(
    `INSERT INTO carriers (id, tenant_id, company, mc_number, dot_number,
       authority_status, insurance_status, insurance_expiry,
       liability_insurance, cargo_insurance, safety_rating,
       carrier_status, contact_phone, contact_email, created_at, updated_at)
     VALUES ($1, $2, $3, '', '', 'Active', 'Active', CURRENT_DATE + INTERVAL '1 year',
       750000, 100000, 'Not Rated', 'active', '+15550009999', $4, NOW(), NOW())`,
    [opts.carrierId, LEGACY_DEFAULT_TENANT_ID, `IMAP Test Carrier ${opts.carrierId}`, opts.contactEmail],
  );

  seededTmsLoadIds.push(opts.tmsLoadId);
  await db.query(
    `INSERT INTO loads (id, origin, destination, source, status, revenue, carrier_id, pipeline_load_id, reference_number, created_at)
     VALUES ($1, 'Toronto, ON', 'Sudbury, ON', 'Load Board', $2, 2200, $3, $4, $5, NOW())`,
    [opts.tmsLoadId, opts.status, opts.carrierId, opts.pipelineLoadId, opts.tmsLoadId],
  );
}

describe('pollInbox (E2-04 M4)', () => {
  afterAll(async () => {
    if (seededMessageIds.length) await db.query(`DELETE FROM inbound_emails WHERE message_id = ANY($1)`, [seededMessageIds]);
    if (seededDocumentLoadIds.length) await db.query(`DELETE FROM documents WHERE related_to = ANY($1)`, [seededDocumentLoadIds]);
    if (seededTmsLoadIds.length) await db.query(`DELETE FROM loads WHERE id = ANY($1)`, [seededTmsLoadIds]);
    if (seededCarrierIds.length) await db.query(`DELETE FROM carriers WHERE id = ANY($1)`, [seededCarrierIds]);
    if (seededPipelineLoadIds.length) await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1)`, [seededPipelineLoadIds]);
  });

  it('an unmatched message is quarantined, not silently dropped', async () => {
    const messageId = `imap-test-unmatched-${RUN_ID}`;
    seededMessageIds.push(messageId);
    const source = rawEmail({ from: 'random@example.com', subject: 'Out of office', text: 'Away until Monday', messageId });
    const client = makeFakeClient([{ uid: 1, source, subject: 'Out of office', fromAddress: 'random@example.com' }]);

    const result = await pollInbox(client);
    expect(result.processed).toBe(1);
    expect(result.quarantined).toBe(1);
    expect(result.matched).toBe(0);

    const row = await db.query<{ quarantined: boolean; reply_type: string | null }>(
      `SELECT quarantined, reply_type FROM inbound_emails WHERE message_id = $1`, [messageId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].quarantined).toBe(true);
    expect(row.rows[0].reply_type).toBeNull();
  }, 15_000);

  it('a shipper reply matched by load_id with a verified sender is stored as paper trail, no state change', async () => {
    const loadId = `TEST-IMAP-SHIP-${RUN_ID}`;
    const shipperEmail = `shipper-${RUN_ID}@test.test`;
    const pipelineLoadId = await seedPipelineLoad({ loadId, shipperEmail });

    const messageId = `imap-test-shipper-${RUN_ID}`;
    seededMessageIds.push(messageId);
    const subject = `Rate Confirmation Needed — Load ${loadId}`;
    const source = rawEmail({
      from: shipperEmail, subject, text: 'Confirmed, see attached.', messageId,
      attachment: { filename: 'signed.pdf', content: '%PDF-1.4 fake shipper reply' },
    });
    const client = makeFakeClient([{ uid: 1, source, subject, fromAddress: shipperEmail }]);

    const result = await pollInbox(client);
    expect(result.matched).toBe(1);

    const row = await db.query<{ matched_load_id: number; sender_verified: boolean; reply_type: string; quarantined: boolean }>(
      `SELECT matched_load_id, sender_verified, reply_type, quarantined FROM inbound_emails WHERE message_id = $1`, [messageId],
    );
    expect(row.rows[0].matched_load_id).toBe(pipelineLoadId);
    expect(row.rows[0].sender_verified).toBe(true);
    expect(row.rows[0].reply_type).toBe('shipper_confirmation_reply');
    expect(row.rows[0].quarantined).toBe(false);

    // No state transition -- stage untouched (paper trail only, per M0).
    const stageRow = await db.query<{ stage: string }>(`SELECT stage FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    expect(stageRow.rows[0].stage).toBe('awaiting_shipper_confirmation');

    // The reply's attachment made it into documents for human review
    // (migration 050 -- documents_type_check needed widening for this).
    const docs = await db.query<{ type: string; related_to: string }>(
      `SELECT type, related_to FROM documents WHERE related_to = $1 AND type = 'Shipper Rate Confirmation Reply'`,
      [loadId],
    );
    expect(docs.rows).toHaveLength(1);
    seededDocumentLoadIds.push(loadId);
  }, 15_000);

  it('a shipper reply from an unverified sender is still matched and stored, flagged unverified', async () => {
    const loadId = `TEST-IMAP-SHIPUNVER-${RUN_ID}`;
    const shipperEmail = `shipper-unver-${RUN_ID}@test.test`;
    await seedPipelineLoad({ loadId, shipperEmail });

    const messageId = `imap-test-shipper-unver-${RUN_ID}`;
    seededMessageIds.push(messageId);
    const subject = `Rate Confirmation Needed — Load ${loadId}`;
    const source = rawEmail({ from: 'someone-else@test.test', subject, text: 'hi', messageId });
    const client = makeFakeClient([{ uid: 1, source, subject, fromAddress: 'someone-else@test.test' }]);

    await pollInbox(client);
    const row = await db.query<{ sender_verified: boolean; verification_note: string | null }>(
      `SELECT sender_verified, verification_note FROM inbound_emails WHERE message_id = $1`, [messageId],
    );
    expect(row.rows[0].sender_verified).toBe(false);
    expect(row.rows[0].verification_note).toMatch(/does not match/);
  }, 15_000);

  it('a verified carrier reply with a signed PDF on an Awaiting Signature load completes the dispatch', async () => {
    const loadId = `TEST-IMAP-CARR-${RUN_ID}`;
    const pipelineLoadId = await seedPipelineLoad({ loadId, shipperEmail: 'x@test.test' });
    const carrierId = `IMAP-CARR-${RUN_ID}`;
    const carrierEmail = `carrier-${RUN_ID}@test.test`;
    const tmsLoadId = `LD-IMAP-${RUN_ID}`;
    await seedCarrierAndTmsLoad({ carrierId, contactEmail: carrierEmail, tmsLoadId, pipelineLoadId, status: 'Awaiting Signature' });

    const messageId = `imap-test-carrier-${RUN_ID}`;
    seededMessageIds.push(messageId);
    const subject = `Rate Confirmation — ${tmsLoadId}`;
    const source = rawEmail({
      from: carrierEmail, subject, text: 'Signed, attached.', messageId,
      attachment: { filename: 'signed-rc.pdf', content: '%PDF-1.4 fake carrier signed copy' },
    });
    const client = makeFakeClient([{ uid: 1, source, subject, fromAddress: carrierEmail }]);

    const result = await pollInbox(client);
    expect(result.matched).toBe(1);

    const row = await db.query<{ status: string; carrier_signature_received_at: Date | null }>(
      `SELECT status, carrier_signature_received_at FROM loads WHERE id = $1`, [tmsLoadId],
    );
    expect(row.rows[0].status).toBe('Dispatched');
    expect(row.rows[0].carrier_signature_received_at).not.toBeNull();
  }, 15_000);

  it('a carrier reply from an unverified sender does NOT complete the dispatch', async () => {
    const loadId = `TEST-IMAP-CARRUNVER-${RUN_ID}`;
    const pipelineLoadId = await seedPipelineLoad({ loadId, shipperEmail: 'x2@test.test' });
    const carrierId = `IMAP-CARRUNVER-${RUN_ID}`;
    const tmsLoadId = `LD-IMAPUNVER-${RUN_ID}`;
    await seedCarrierAndTmsLoad({ carrierId, contactEmail: `real-carrier-${RUN_ID}@test.test`, tmsLoadId, pipelineLoadId, status: 'Awaiting Signature' });

    const messageId = `imap-test-carrier-unver-${RUN_ID}`;
    seededMessageIds.push(messageId);
    const subject = `Rate Confirmation — ${tmsLoadId}`;
    const source = rawEmail({
      from: 'spoofed@test.test', subject, text: 'signed', messageId,
      attachment: { filename: 'signed.pdf', content: '%PDF-1.4 spoofed' },
    });
    const client = makeFakeClient([{ uid: 1, source, subject, fromAddress: 'spoofed@test.test' }]);

    await pollInbox(client);
    const row = await db.query<{ status: string }>(`SELECT status FROM loads WHERE id = $1`, [tmsLoadId]);
    expect(row.rows[0].status).toBe('Awaiting Signature'); // unchanged
  }, 15_000);

  it('re-polling the same message (same Message-ID) does not reprocess or duplicate the row', async () => {
    const loadId = `TEST-IMAP-DEDUP-${RUN_ID}`;
    const shipperEmail = `dedup-${RUN_ID}@test.test`;
    await seedPipelineLoad({ loadId, shipperEmail });

    const messageId = `imap-test-dedup-${RUN_ID}`;
    seededMessageIds.push(messageId);
    const subject = `Rate Confirmation Needed — Load ${loadId}`;
    const source = rawEmail({ from: shipperEmail, subject, text: 'hi', messageId });
    const client = makeFakeClient([{ uid: 1, source, subject, fromAddress: shipperEmail }]);

    const first = await pollInbox(client);
    const second = await pollInbox(client); // same UID/message again, e.g. a re-run before flag propagates
    expect(first.matched).toBe(1);
    expect(second.processed).toBe(1); // still fetched...
    expect(second.matched).toBe(0); // ...but not re-matched/re-inserted

    const row = await db.query(`SELECT 1 FROM inbound_emails WHERE message_id = $1`, [messageId]);
    expect(row.rows).toHaveLength(1);
  }, 15_000);
});
