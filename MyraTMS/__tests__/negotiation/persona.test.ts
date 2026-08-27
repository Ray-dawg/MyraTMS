import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '@/lib/pipeline/db-adapter';
import { selectPersonaForDirection } from '@/lib/negotiation/persona';

vi.mock('@/lib/pipeline/db-adapter', () => ({ db: { query: vi.fn() } }));

describe('selectPersonaForDirection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries call_type=outbound_shipper for direction=sell', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [{ id: 1, persona_name: 'friendly', alpha: '1', beta: '1', total_calls: 0, retell_agent_id_en: 'agent_1', retell_agent_id_fr: null }],
    });
    await selectPersonaForDirection('sell');
    const sql = (db.query as any).mock.calls[0][0] as string;
    expect(sql).toContain("call_type = 'outbound_shipper'");
  });

  it('queries call_type=outbound_carrier for direction=buy', async () => {
    (db.query as any).mockResolvedValueOnce({
      rows: [{ id: 2, persona_name: 'assertive', alpha: '1', beta: '1', total_calls: 0, retell_agent_id_en: 'agent_2', retell_agent_id_fr: null }],
    });
    await selectPersonaForDirection('buy');
    const sql = (db.query as any).mock.calls[0][0] as string;
    expect(sql).toContain("call_type = 'outbound_carrier'");
  });

  it('throws when no active personas exist for the pool', async () => {
    (db.query as any).mockResolvedValueOnce({ rows: [] });
    await expect(selectPersonaForDirection('buy')).rejects.toThrow(/No active personas/);
  });
});
