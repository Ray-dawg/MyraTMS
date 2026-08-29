// lib/risk/__tests__/banking-change-detection.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { bridgeToExceptions } from '@/lib/exceptions/bridge';
import { checkBankingChange } from '@/lib/risk/banking-change-detection';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));
vi.mock('@/lib/exceptions/bridge', () => ({ bridgeToExceptions: vi.fn(async () => true) }));
vi.mock('@/lib/tenants/get-myra-tenant-id', () => ({ getMyraTenantId: vi.fn(async () => 2) }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkBankingChange', () => {
  it('halts every active load when banking details differ from what is on file', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [{ bank_name: 'Bank A', routing_number: '111', account_number_last4: '1234' }] }) // on file
      .mockResolvedValueOnce({ rows: [{ id: 501 }, { id: 502 }] }) // active pipeline loads
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // insert halt load 501
      .mockResolvedValueOnce({ rows: [{ id: 2 }] }); // insert halt load 502

    const result = await checkBankingChange(7, { bankName: 'Bank B', routingNumber: '222', accountNumberLast4: '5678' });
    expect(result.halted).toBe(true);
    expect(result.loadsHalted).toEqual([501, 502]);
    expect(bridgeToExceptions).toHaveBeenCalledTimes(2);
  });

  it('does not halt when incoming details match what is on file', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ bank_name: 'Bank A', routing_number: '111', account_number_last4: '1234' }] });

    const result = await checkBankingChange(7, { bankName: 'Bank A', routingNumber: '111', accountNumberLast4: '1234' });
    expect(result.halted).toBe(false);
    expect(bridgeToExceptions).not.toHaveBeenCalled();
  });

  it('does not halt when there is no active load, even if banking details differ', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [{ bank_name: 'Bank A', routing_number: '111', account_number_last4: '1234' }] })
      .mockResolvedValueOnce({ rows: [] }); // no active loads

    const result = await checkBankingChange(7, { bankName: 'Bank B', routingNumber: '222', accountNumberLast4: '5678' });
    expect(result.halted).toBe(false);
    expect(bridgeToExceptions).not.toHaveBeenCalled();
  });

  it('does not halt when there is nothing on file yet (first time recording banking details)', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [] }); // nothing on file
    const result = await checkBankingChange(7, { bankName: 'Bank A', routingNumber: '111', accountNumberLast4: '1234' });
    expect(result.halted).toBe(false);
    expect(bridgeToExceptions).not.toHaveBeenCalled();
  });
});
