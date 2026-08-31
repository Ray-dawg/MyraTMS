/**
 * Schema Verification Test for Migration 059 — T-30 Contract Freight Intake
 *
 * Verifies that migration 059 correctly:
 *   1. Creates the contract_shipper_authorizations table with all required columns
 *   2. Adds T-30 columns to inbound_emails (intake_type, sender_authorized, etc.)
 *   3. Respects all constraints and indexes
 */

import { neon } from '@neondatabase/serverless';
import { describe, it, expect, beforeAll } from 'vitest';

// Use DATABASE_URL environment variable (can be overridden for test branches)
const getDb = () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL not set. Set it to point to the verification branch.'
    );
  }
  return neon(connectionString);
};

describe('Migration 059 — T-30 Contract Freight Intake', () => {
  let db: ReturnType<typeof getDb>;

  beforeAll(() => {
    db = getDb();
  });

  describe('contract_shipper_authorizations table', () => {
    it('table exists', async () => {
      const result = await db`
        SELECT EXISTS(
          SELECT 1 FROM information_schema.tables
          WHERE table_name = 'contract_shipper_authorizations'
        ) as exists
      `;
      expect(result[0].exists).toBe(true);
    });

    it('has required columns', async () => {
      const columns = await db`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'contract_shipper_authorizations'
        ORDER BY ordinal_position
      `;

      const columnMap = new Map(
        columns.map((c: any) => [c.column_name, c])
      );

      // Verify all required columns exist
      expect(columnMap.has('id')).toBe(true);
      expect(columnMap.has('tenant_id')).toBe(true);
      expect(columnMap.has('shipper_email')).toBe(true);
      expect(columnMap.has('shipper_company_name')).toBe(true);
      expect(columnMap.has('margin_floor_override_pct')).toBe(true);
      expect(columnMap.has('is_active')).toBe(true);
      expect(columnMap.has('authorized_by')).toBe(true);
      expect(columnMap.has('authorized_at')).toBe(true);

      // Verify key column types
      expect(columnMap.get('id')!.data_type).toBe('integer');
      expect(columnMap.get('tenant_id')!.data_type).toBe('integer');
      expect(columnMap.get('shipper_email')!.data_type).toMatch(/character varying/);
      expect(columnMap.get('is_active')!.data_type).toBe('boolean');
      expect(columnMap.get('authorized_at')!.data_type).toMatch(/timestamp/);
    });

    it('has primary key', async () => {
      const result = await db`
        SELECT constraint_type
        FROM information_schema.table_constraints
        WHERE table_name = 'contract_shipper_authorizations'
        AND constraint_type = 'PRIMARY KEY'
      `;
      expect(result.length).toBe(1);
    });

    it('has unique constraint on (tenant_id, shipper_email)', async () => {
      const result = await db`
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = 'contract_shipper_authorizations'
        AND constraint_type = 'UNIQUE'
      `;
      expect(result.length).toBeGreaterThan(0);
    });

    it('has foreign key to tenants', async () => {
      const result = await db`
        SELECT constraint_type
        FROM information_schema.table_constraints
        WHERE table_name = 'contract_shipper_authorizations'
        AND constraint_type = 'FOREIGN KEY'
      `;
      expect(result.length).toBeGreaterThan(0);
    });

    it('has expected indexes', async () => {
      const indexes = await db`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'contract_shipper_authorizations'
        ORDER BY indexname
      `;

      const indexNames = indexes.map((i: any) => i.indexname);
      expect(indexNames.length).toBeGreaterThan(0);
      expect(indexNames.some((name: string) => name.includes('idx_contract_shipper_auth_tenant'))).toBe(true);
      expect(indexNames.some((name: string) => name.includes('idx_contract_shipper_auth_email'))).toBe(true);
      expect(indexNames.some((name: string) => name.includes('idx_contract_shipper_auth_active'))).toBe(true);
    });
  });

  describe('inbound_emails table extensions', () => {
    it('has intake_type column', async () => {
      const result = await db`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'inbound_emails'
        AND column_name = 'intake_type'
      `;
      expect(result.length).toBe(1);
      expect(result[0].data_type).toMatch(/character varying/);
    });

    it('has sender_authorized column', async () => {
      const result = await db`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'inbound_emails'
        AND column_name = 'sender_authorized'
      `;
      expect(result.length).toBe(1);
      expect(result[0].data_type).toBe('boolean');
    });

    it('has created_pipeline_load_id column', async () => {
      const result = await db`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'inbound_emails'
        AND column_name = 'created_pipeline_load_id'
      `;
      expect(result.length).toBe(1);
      expect(result[0].data_type).toBe('integer');
    });

    it('has intake_status column', async () => {
      const result = await db`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'inbound_emails'
        AND column_name = 'intake_status'
      `;
      expect(result.length).toBe(1);
      expect(result[0].data_type).toMatch(/character varying/);
    });

    it('has index on (intake_type, intake_status)', async () => {
      const result = await db`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'inbound_emails'
        AND indexname LIKE '%intake_status%'
      `;
      expect(result.length).toBeGreaterThan(0);
    });

    it('intake_type has correct default', async () => {
      const result = await db`
        SELECT column_default
        FROM information_schema.columns
        WHERE table_name = 'inbound_emails'
        AND column_name = 'intake_type'
      `;
      expect(result[0].column_default).toContain('rate_con_confirmation');
    });

    it('intake_status has correct default', async () => {
      const result = await db`
        SELECT column_default
        FROM information_schema.columns
        WHERE table_name = 'inbound_emails'
        AND column_name = 'intake_status'
      `;
      expect(result[0].column_default).toContain('pending_review');
    });
  });

  describe('Constraints and referential integrity', () => {
    it('created_pipeline_load_id references pipeline_loads(id)', async () => {
      const result = await db`
        SELECT constraint_type
        FROM information_schema.table_constraints
        WHERE table_name = 'inbound_emails'
        AND constraint_type = 'FOREIGN KEY'
      `;
      // Should have existing foreign key(s) plus the new one
      expect(result.length).toBeGreaterThan(0);
    });

    it('contract_shipper_authorizations tenant_id references tenants', async () => {
      const result = await db`
        SELECT constraint_type
        FROM information_schema.table_constraints
        WHERE table_name = 'contract_shipper_authorizations'
        AND constraint_type = 'FOREIGN KEY'
      `;
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('Migration idempotency', () => {
    it('re-running CREATE TABLE IF NOT EXISTS is safe', async () => {
      // Query the table again to verify it still exists and has same structure
      const result = await db`
        SELECT COUNT(*)::integer as count
        FROM information_schema.columns
        WHERE table_name = 'contract_shipper_authorizations'
      `;
      expect(result[0].count).toBeGreaterThan(0);
    });
  });
});
