// __tests__/documents/t26-schema.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

const REF = `T26SCHEMA-${Date.now()}`;

describe('T-26 schema (056)', () => {
  it('adds parsed_terms and terms_match_status to documents', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'documents' AND column_name IN ('parsed_terms', 'terms_match_status')`,
    );
    expect(rows.length).toBe(2);
  });

  describe('document-lifecycle triggers', () => {
    let pipelineLoadId: number;
    let tmsLoadId: string;

    beforeAll(async () => {
      const pl = await db.query<{ id: number }>(
        `INSERT INTO pipeline_loads (load_id, load_board_source, origin_city, origin_state, origin_country,
           destination_city, destination_state, destination_country, pickup_date, delivery_date, equipment_type, stage)
         VALUES ($1, 'DAT', 'A', 'ON', 'CA', 'B', 'ON', 'CA', NOW(), NOW(), 'Dry Van', 'dispatched') RETURNING id`,
        [`${REF}-PL`],
      );
      pipelineLoadId = pl.rows[0].id;
      tmsLoadId = `LD-${REF}`;
      await db.query(
        `INSERT INTO loads (id, origin, destination, status, pipeline_load_id) VALUES ($1, 'A', 'B', 'Booked', $2)`,
        [tmsLoadId, pipelineLoadId],
      );
    });

    afterAll(async () => {
      await db.query(`DELETE FROM events WHERE pipeline_load_id = $1`, [pipelineLoadId]);
      await db.query(`DELETE FROM inbound_emails WHERE matched_load_id = $1`, [pipelineLoadId]);
      await db.query(`DELETE FROM documents WHERE related_to = $1`, [tmsLoadId]);
      await db.query(`DELETE FROM loads WHERE id = $1`, [tmsLoadId]);
      await db.query(`DELETE FROM pipeline_loads WHERE id = $1`, [pipelineLoadId]);
    });

    it('BOL insert emits document.bol_uploaded', async () => {
      await db.query(
        `INSERT INTO documents (id, name, type, related_to, related_type, tenant_id) VALUES ($1, 'bol.pdf', 'BOL', $2, 'Load', 2)`,
        [`DOC-${REF}-BOL`, tmsLoadId],
      );
      const events = await db.query(
        `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'document.bol_uploaded'`,
        [pipelineLoadId],
      );
      expect(events.rows.length).toBe(1);
    });

    it('Rate Confirmation insert emits document.rate_con_sent', async () => {
      await db.query(
        `INSERT INTO documents (id, name, type, related_to, related_type, tenant_id) VALUES ($1, 'rc.pdf', 'Rate Confirmation', $2, 'Load', 2)`,
        [`DOC-${REF}-RC`, tmsLoadId],
      );
      const events = await db.query(
        `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'document.rate_con_sent'`,
        [pipelineLoadId],
      );
      expect(events.rows.length).toBe(1);
    });

    it('terms_match_status -> mismatch emits document.terms_mismatch_detected', async () => {
      const docId = `DOC-${REF}-MISMATCH`;
      await db.query(
        `INSERT INTO documents (id, name, type, related_to, related_type, tenant_id, terms_match_status)
         VALUES ($1, 'reply.pdf', 'Shipper Rate Confirmation Reply', $2, 'Load', 2, 'not_checked')`,
        [docId, tmsLoadId],
      );
      await db.query(`UPDATE documents SET terms_match_status = 'mismatch' WHERE id = $1`, [docId]);
      const events = await db.query(
        `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'document.terms_mismatch_detected'`,
        [pipelineLoadId],
      );
      expect(events.rows.length).toBe(1);
    });

    it('inbound_emails insert with reply_type=shipper_confirmation_reply emits rate_con_received + rate_con_matched', async () => {
      await db.query(
        `INSERT INTO inbound_emails (message_id, from_address, subject, received_at, matched_load_id, match_method, sender_verified, reply_type, attachment_count, processed_at, quarantined)
         VALUES ($1, 'shipper@example.com', 'Re: Rate Confirmation Needed', NOW(), $2, 'subject_load_id', true, 'shipper_confirmation_reply', 1, NOW(), false)`,
        [`${REF}-msg-1`, pipelineLoadId],
      );
      const received = await db.query(
        `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'document.rate_con_received'`,
        [pipelineLoadId],
      );
      const matched = await db.query(
        `SELECT * FROM events WHERE pipeline_load_id = $1 AND event_type = 'document.rate_con_matched'`,
        [pipelineLoadId],
      );
      expect(received.rows.length).toBe(1);
      expect(matched.rows.length).toBe(1);
    });
  });
});
