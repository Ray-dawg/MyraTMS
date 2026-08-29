// __tests__/risk/t25-schema.test.ts
import { describe, it, expect } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

describe('T-25 schema (055)', () => {
  it('creates all 4 new tables and the 2 additive columns', async () => {
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('payer_registry','payer_credit_assessments','transaction_halts','carrier_banking_details')`,
    );
    expect(tables.rows.length).toBe(4);

    const cols = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'pipeline_loads' AND column_name = 'payer_registry_id')
           OR (table_name = 'tenant_policies' AND column_name = 'concentration_cap_pct')`,
    );
    expect(cols.rows.length).toBe(2);
  });

  it('seeds the 2 new classification-rule rows without touching the existing 5', async () => {
    const { rows } = await db.query<{ source_module: string }>(
      `SELECT source_module FROM exception_classification_rules WHERE tenant_id = 2 ORDER BY source_module, version`,
    );
    expect(rows.length).toBe(7);
    expect(rows.map((r) => r.source_module)).toContain('payer_risk');
    expect(rows.map((r) => r.source_module)).toContain('transaction_halt');
  });
});
