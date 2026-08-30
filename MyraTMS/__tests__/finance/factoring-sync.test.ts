import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: (...args: any[]) => queryMock(...args) } }));

import { syncInvoiceFactoringStatus } from '@/lib/finance/factoring-sync';

describe('T-27 invoice.factoring_status sync (criterion 5)', () => {
  beforeEach(() => queryMock.mockReset());

  it('updates the existing invoices.factoring_status field via the pipeline_loads.tms_load_id -> invoices.load_id join', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'INV-1' }] });
    const updated = await syncInvoiceFactoringStatus(42, 'Submitted');
    expect(updated).toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/UPDATE invoices/);
    expect(sql).toMatch(/tms_load_id/);
    expect(params).toEqual(['Submitted', 42]);
  });

  it('returns false when the pipeline load has no dispatched TMS load or invoice yet — not an error', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await syncInvoiceFactoringStatus(42, 'Submitted')).toBe(false);
  });
});
