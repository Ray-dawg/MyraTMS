// lib/exceptions/__tests__/classification-rules.test.ts
import { describe, it, expect, vi } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { matchClassificationRule } from '@/lib/exceptions/classification-rules';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));

describe('matchClassificationRule', () => {
  it('picks the highest-severity rule whose condition is satisfied (six-hour-late case)', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [
        { severity: 'low', sla_minutes: 240, suggested_action: 'Monitor.', condition: { time_overdue_minutes: { '>=': 20 } } },
        { severity: 'critical', sla_minutes: 30, suggested_action: 'Contact now.', condition: { time_overdue_minutes: { '>=': 360 } } },
      ],
    });
    const rule = await matchClassificationRule(2, 'lifecycle_late', { time_overdue_minutes: 400 });
    expect(rule).toEqual({ severity: 'critical', slaMinutes: 30, suggestedAction: 'Contact now.' });
  });

  it('falls back to the routine-tier rule when only the lower threshold is met', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [
        { severity: 'low', sla_minutes: 240, suggested_action: 'Monitor.', condition: { time_overdue_minutes: { '>=': 20 } } },
        { severity: 'critical', sla_minutes: 30, suggested_action: 'Contact now.', condition: { time_overdue_minutes: { '>=': 360 } } },
      ],
    });
    const rule = await matchClassificationRule(2, 'lifecycle_late', { time_overdue_minutes: 45 });
    expect(rule?.severity).toBe('low');
  });

  it('matches an always-true ({}) condition regardless of context', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [{ severity: 'medium', sla_minutes: 1440, suggested_action: 'Review.', condition: {} }],
    });
    const rule = await matchClassificationRule(2, 'carrier_risk', {});
    expect(rule?.severity).toBe('medium');
  });

  it('returns null when no active rule exists for the source_module', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [] });
    const rule = await matchClassificationRule(2, 'unknown_source', {});
    expect(rule).toBeNull();
  });
});
