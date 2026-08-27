import { describe, it, expect, vi } from 'vitest';
import { POST } from '@/app/api/negotiation/envelope/route';

vi.mock('@/lib/governance/api-helpers', () => ({
  authorizeGovernanceRequest: vi.fn().mockReturnValue({ user: { tenantId: 2 } }),
}));
vi.mock('@/lib/negotiation', () => ({
  compileEnvelope: vi.fn().mockResolvedValue({ meta: { direction: 'sell' } }),
}));

describe('POST /api/negotiation/envelope', () => {
  it('rejects a missing direction', async () => {
    const req = new Request('http://localhost/api/negotiation/envelope', {
      method: 'POST', body: JSON.stringify({ pipelineLoadId: 1, counterpartyId: 0 }),
    }) as any;
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns a brief for a valid sell-direction request', async () => {
    const req = new Request('http://localhost/api/negotiation/envelope', {
      method: 'POST', body: JSON.stringify({ direction: 'sell', pipelineLoadId: 1, counterpartyId: 0 }),
    }) as any;
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});
