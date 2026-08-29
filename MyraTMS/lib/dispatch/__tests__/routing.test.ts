// lib/dispatch/__tests__/routing.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { resolveDispatchRouting, setDispatchRoutingOverride } from '@/lib/dispatch/routing';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveDispatchRouting', () => {
  it('returns the active override when one exists', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [{ mode: 'in_house_notify', notify_contact: 'ops@carrier.test' }] });
    const result = await resolveDispatchRouting(2);
    expect(result).toEqual({ mode: 'in_house_notify', notifyContact: 'ops@carrier.test', source: 'override' });
  });

  it('falls back to tenant_policies.dispatch_agent_enabled=true → myra_managed when no override row exists', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ dispatch_agent_enabled: true }] });
    const result = await resolveDispatchRouting(2);
    expect(result).toEqual({ mode: 'myra_managed', notifyContact: null, source: 'tenant_policy_default' });
  });

  it('falls back to dispatch_agent_enabled=false → in_house_notify with no override row', async () => {
    (db.query as any)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ dispatch_agent_enabled: false }] });
    const result = await resolveDispatchRouting(3);
    expect(result.mode).toBe('in_house_notify');
    expect(result.source).toBe('tenant_policy_default');
  });
});

describe('setDispatchRoutingOverride', () => {
  it('throws when mode=in_house_notify with no notifyContact', async () => {
    await expect(setDispatchRoutingOverride(3, 'in_house_notify', null)).rejects.toThrow(/notifyContact is required/);
  });

  it('upserts when valid', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [] });
    await setDispatchRoutingOverride(3, 'in_house_notify', 'dispatch@carrier.test');
    const sql = (db.query as any).mock.calls[0][0] as string;
    expect(sql).toContain('ON CONFLICT (tenant_id)');
  });
});
