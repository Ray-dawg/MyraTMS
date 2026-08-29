/**
 * lib/email/imap-poller.ts — T-26 term-extraction extension, end to end.
 * Same fake-ImapClientLike-with-real-raw-MIME convention as
 * __tests__/pipeline/imap-poller.test.ts (E2-04 M4's own suite, unmodified
 * by this change and re-verified separately). Exercises the ACTUAL Claude
 * API call (no mock) against a deliberately-invalid PDF attachment, so the
 * real, honest outcome is 'unparseable' — proving the new code path runs
 * end-to-end (extraction attempted, comparison invoked, documents row
 * updated) without needing a real shipper rate-con sample, which doesn't
 * exist yet in this environment.
 */

import { describe, it, expect, afterAll, vi } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { pollInbox, type ImapClientLike, type ImapFetchedMessage } from '@/lib/email/imap-poller';

vi.mock('@vercel/blob', () => ({
  put: vi.fn(async (filename: string) => ({ url: `https://blob.test/${filename}` })),
}));

const RUN_ID = Date.now();
const seededPipelineLoadIds: number[] = [];
const seededMessageIds: string[] = [];
const seededDocumentLoadIds: string[] = [];

function rawEmailWithAttachment(opts: { from: string; subject: string; text: string; messageId: string }): Buffer {
  const boundary = '----test-boundary';
  return Buffer.from(
    [
      `From: ${opts.from}`,
      `To: dispatch@myralogistics.com`,
      `Subject: ${opts.subject}`,
      `Message-ID: <${opts.messageId}>`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      '',
      opts.text,
      `--${boundary}`,
      `Content-Type: application/pdf`,
      `Content-Disposition: attachment; filename="reply.pdf"`,
      `Content-Transfer-Encoding: base64`,
      '',
      Buffer.from('not a real pdf').toString('base64'),
      `--${boundary}--`,
    ].join('\r\n'),
  );
}

function makeFakeClient(messages: Array<{ uid: number; source: Buffer; subject: string; fromAddress: string }>): ImapClientLike {
  return {
    connect: vi.fn(async () => {}),
    mailboxOpen: vi.fn(async () => {}),
    search: vi.fn(async () => messages.map((m) => m.uid)),
    fetchOne: vi.fn(async (uid: number): Promise<ImapFetchedMessage | false> => {
      const m = messages.find((x) => x.uid === uid);
      if (!m) return false;
      return { uid: m.uid, envelope: { subject: m.subject, from: [{ address: m.fromAddress }] }, source: m.source };
    }),
    messageFlagsAdd: vi.fn(async () => true),
    logout: vi.fn(async () => {}),
  };
}

async function seedPipelineLoad(loadId: string, shipperEmail: string): Promise<number> {
  const ins = await db.query<{ id: number }>(
    `INSERT INTO pipeline_loads (
       load_id, load_board_source, origin_city, origin_state, origin_country,
       destination_city, destination_state, destination_country,
       pickup_date, delivery_date, equipment_type, weight_lbs,
       shipper_company, shipper_email, shipper_phone, stage, agreed_rate, agreed_rate_currency
     ) VALUES ($1, 'DAT', 'Toronto', 'ON', 'CA', 'Sudbury', 'ON', 'CA',
       NOW() + INTERVAL '3 days', NOW() + INTERVAL '4 days', 'Dry Van', 42000,
       'T26 IMAP Test Co', $2, '+17055550000', 'booked', 2400, 'CAD'
     ) RETURNING id`,
    [loadId, shipperEmail],
  );
  seededPipelineLoadIds.push(ins.rows[0].id);
  return ins.rows[0].id;
}

describe('imap-poller.ts shipper_reply branch — term extraction extension (T-26)', () => {
  afterAll(async () => {
    if (seededMessageIds.length) await db.query(`DELETE FROM inbound_emails WHERE message_id = ANY($1)`, [seededMessageIds]);
    if (seededDocumentLoadIds.length) await db.query(`DELETE FROM documents WHERE related_to = ANY($1)`, [seededDocumentLoadIds]);
    if (seededPipelineLoadIds.length) {
      await db.query(`DELETE FROM events WHERE pipeline_load_id = ANY($1)`, [seededPipelineLoadIds]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = ANY($1)`, [seededPipelineLoadIds]);
    }
  });

  it(
    'extracts terms (honestly failing on a non-PDF attachment) and writes terms_match_status onto the attached document',
    async () => {
      const loadId = `T26-IMAP-${RUN_ID}`;
      const shipperEmail = `shipper-${RUN_ID}@example.com`;
      await seedPipelineLoad(loadId, shipperEmail);
      seededDocumentLoadIds.push(loadId);

      const messageId = `t26-imap-terms-${RUN_ID}`;
      seededMessageIds.push(messageId);
      const source = rawEmailWithAttachment({
        from: shipperEmail,
        subject: `Re: Rate Confirmation Needed — Load ${loadId}`,
        text: 'Signed, see attached.',
        messageId,
      });
      const client = makeFakeClient([{ uid: 1, source, subject: `Re: Rate Confirmation Needed — Load ${loadId}`, fromAddress: shipperEmail }]);

      const result = await pollInbox(client);
      expect(result.matched).toBe(1);

      const doc = await db.query<{ terms_match_status: string; parsed_terms: unknown }>(
        `SELECT terms_match_status, parsed_terms FROM documents WHERE related_to = $1 AND type = 'Shipper Rate Confirmation Reply'`,
        [loadId],
      );
      expect(doc.rows.length).toBe(1);
      // Real Claude call against a deliberately non-PDF attachment — the
      // honest outcome is 'unparseable', not a mocked 'match'/'mismatch'.
      expect(doc.rows[0].terms_match_status).toBe('unparseable');
    },
    30000,
  );
});
