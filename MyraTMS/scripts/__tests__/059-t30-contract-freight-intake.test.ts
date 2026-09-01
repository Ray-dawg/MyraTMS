// scripts/__tests__/059-t30-contract-freight-intake.test.ts
//
// Run with DATABASE_URL pointed at the t30-verify branch (quote the value —
// it contains an unquoted '&' that a shell will otherwise treat as a
// background-job separator, the exact bug T-28's session hit).
import { describe, it, expect } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

describe('migration 059 — schema verification', () => {
  it('creates contract_shipper_authorizations with the expected columns', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'contract_shipper_authorizations'`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'tenant_id', 'shipper_email', 'shipper_company_name',
      'margin_floor_override_amount', 'is_active', 'authorized_by', 'authorized_at',
    ]));
  });

  it('adds the expected columns to inbound_emails', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'inbound_emails'
        AND column_name IN ('intake_type', 'sender_authorized', 'created_pipeline_load_id', 'intake_status')`,
    );
    expect(rows.length).toBe(4);
  });

  it('adds source_type (defaulted) and booked_via to pipeline_loads', async () => {
    const { rows } = await db.query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'pipeline_loads' AND column_name IN ('source_type', 'booked_via')`,
    );
    expect(rows.length).toBe(2);
    const sourceType = rows.find((r) => r.column_name === 'source_type');
    expect(sourceType?.column_default).toContain('load_board');
  });

  it('adds inbound_email_id to exceptions', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'exceptions' AND column_name = 'inbound_email_id'`,
    );
    expect(rows.length).toBe(1);
  });
});
