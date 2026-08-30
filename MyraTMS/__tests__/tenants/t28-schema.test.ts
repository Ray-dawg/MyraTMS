import { describe, it, expect } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';

describe('T-28 schema', () => {
  it('tenant_onboarding_sessions accepts a minimal insert and defaults correctly', async () => {
    const { rows } = await db.query<{
      id: number; current_step: string; status: string; step_data: object;
    }>(`INSERT INTO tenant_onboarding_sessions DEFAULT VALUES RETURNING id, current_step, status, step_data`);
    expect(rows[0].current_step).toBe('sign_up');
    expect(rows[0].status).toBe('in_progress');
    expect(rows[0].step_data).toEqual({});
    await db.query(`DELETE FROM tenant_onboarding_sessions WHERE id = $1`, [rows[0].id]);
  });

  it('rejects an invalid current_step', async () => {
    await expect(
      db.query(`INSERT INTO tenant_onboarding_sessions (current_step) VALUES ('not_a_real_step')`),
    ).rejects.toThrow();
  });

  it('seeded exactly one tenant_onboarding classification rule', async () => {
    const { rows } = await db.query<{ severity: string }>(
      `SELECT severity FROM exception_classification_rules WHERE source_module = 'tenant_onboarding'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe('medium');
  });
});
