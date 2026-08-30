import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { syncInvoiceFactoringStatus } from '@/lib/finance/factoring-sync';

describe('T-27 invoice.factoring_status sync (criterion 5)', () => {
  beforeEach(() => queryMock.mockReset());

  it('updates the existing invoices.factoring_status field via the pipeline_loads.tms_load_id -> invoices.load_id join', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'INV-1' }] });
    const updated = await syncInvoiceFactoringStatus(42, 'Submitted', 2);
    expect(updated).toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/UPDATE invoices/);
    expect(sql).toMatch(/tms_load_id/);
    expect(params).toEqual(['Submitted', 42, 2]);
  });

  it('scopes the UPDATE to the caller\'s tenant — app-layer tenant_id is the only live boundary (RLS in migration 029 is not enabled)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'INV-1' }] });
    await syncInvoiceFactoringStatus(42, 'Submitted', 2);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/tenant_id = \$3/);
    expect(params[2]).toBe(2);
  });

  it('returns false when the invoice belongs to a different tenant — no cross-tenant write', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await syncInvoiceFactoringStatus(42, 'Submitted', 99)).toBe(false);
  });

  it('returns false when the pipeline load has no dispatched TMS load or invoice yet — not an error', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await syncInvoiceFactoringStatus(42, 'Submitted', 2)).toBe(false);
  });
});
