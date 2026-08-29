// lib/exceptions/__tests__/bridge.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withTenant } from '@/lib/db/tenant-context';
import { matchClassificationRule } from '@/lib/exceptions/classification-rules';
import { bridgeToExceptions } from '@/lib/exceptions/bridge';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));
vi.mock('@/lib/db/tenant-context', () => ({ withTenant: vi.fn((_id: number, cb: any) => cb({ query: vi.fn().mockResolvedValue({ rows: [] }) })) }));
vi.mock('@/lib/exceptions/classification-rules', () => ({ matchClassificationRule: vi.fn() }));

describe('bridgeToExceptions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no-ops for sourceModule=authority_shadow without querying anything', async () => {
    const result = await bridgeToExceptions({
      tenantId: 2, sourceModule: 'authority_shadow', exceptionType: 'x', context: {},
    } as any);
    expect(result).toBe(false);
    expect(matchClassificationRule).not.toHaveBeenCalled();
  });

  it('returns false and does not insert when no classification rule matches', async () => {
    (matchClassificationRule as any).mockResolvedValueOnce(null);
    const result = await bridgeToExceptions({
      tenantId: 2, sourceModule: 'carrier_risk', exceptionType: 'carrier_risk_signal',
      title: 'x', description: 'y', context: {}, pipelineLoadId: null, loadId: null, carrierId: null,
    });
    expect(result).toBe(false);
  });

  it('inserts via withTenant when a rule matches and no active duplicate exists', async () => {
    (matchClassificationRule as any).mockResolvedValueOnce({ severity: 'medium', slaMinutes: 1440, suggestedAction: 'Review.' });
    const queryMock = vi.fn()
      .mockResolvedValueOnce({ rows: [] })   // dedup check: none active
      .mockResolvedValueOnce({ rows: [{ id: 'exc-1' }] }); // insert
    (withTenant as any).mockImplementationOnce((_id: number, cb: any) => cb({ query: queryMock }));

    const result = await bridgeToExceptions({
      tenantId: 2, sourceModule: 'carrier_risk', exceptionType: 'carrier_risk_signal',
      title: 'Carrier risk detected', description: 'Excessive cancellations', context: {},
      pipelineLoadId: null, loadId: null, carrierId: 'CAR-1',
    });
    expect(result).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});
