// lib/risk/__tests__/payer-credit.test.ts
import { describe, it, expect, vi } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { getPayerCreditStatus, getConcentrationCap } from '@/lib/risk/payer-credit';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));

describe('getPayerCreditStatus', () => {
  it('treats a payer with no assessment on file as unknown and flagged (acceptance criterion 2)', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [] });
    const status = await getPayerCreditStatus(1);
    expect(status).toEqual({ creditLevel: 'unknown', flagged: true, reason: 'No credit assessment on file.' });
  });

  it('flags a weak-credit payer', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ credit_level: 'weak' }] });
    const status = await getPayerCreditStatus(2);
    expect(status.flagged).toBe(true);
    expect(status.creditLevel).toBe('weak');
  });

  it('does not flag a strong-credit payer', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ credit_level: 'strong' }] });
    const status = await getPayerCreditStatus(3);
    expect(status.flagged).toBe(false);
  });
});

describe('getConcentrationCap', () => {
  it('defaults to 25 when tenant_policies.concentration_cap_pct is NULL', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ concentration_cap_pct: null }] });
    expect(await getConcentrationCap(2)).toBe(25);
  });

  it('uses the tenant override when set', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ concentration_cap_pct: '15.00' }] });
    expect(await getConcentrationCap(2)).toBe(15);
  });
});
