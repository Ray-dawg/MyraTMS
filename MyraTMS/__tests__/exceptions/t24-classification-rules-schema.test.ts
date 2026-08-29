// __tests__/exceptions/t24-classification-rules-schema.test.ts
import { describe, it, expect } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

describe('exception_classification_rules (054)', () => {
  it('has the 5 seeded rows with the expected source_module/severity pairs', async () => {
    const { rows } = await db.query<{ source_module: string; severity: string; version: number }>(
      `SELECT source_module, severity, version FROM exception_classification_rules
        WHERE tenant_id = 2 ORDER BY source_module, version`,
    );
    expect(rows).toEqual([
      { source_module: 'carrier_risk', severity: 'medium', version: 1 },
      { source_module: 'dead_letter', severity: 'high', version: 1 },
      { source_module: 'lifecycle_late', severity: 'low', version: 1 },
      { source_module: 'lifecycle_late', severity: 'critical', version: 2 },
      { source_module: 'stage_escalated', severity: 'high', version: 1 },
    ]);
  });

  it('existing exceptions table already has all T-24 §4.2 columns (no ALTER needed)', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'exceptions'
          AND column_name IN ('tenant_id','pipeline_load_id','source_module','suggested_action','sla_due_at')`,
    );
    expect(rows.length).toBe(5);
  });
});
