import { describe, it, expect, vi } from 'vitest';
import { POST } from '@/app/api/negotiation/envelope/route';
import { compileEnvelope } from '@/lib/negotiation';

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

  it('rejects a buy-direction request with no counterpartyId (Fix 3: must not silently default to 0)', async () => {
    const req = new Request('http://localhost/api/negotiation/envelope', {
      method: 'POST', body: JSON.stringify({ direction: 'buy', pipelineLoadId: 1 }),
    }) as any;
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/counterpartyId/);
  });

  it('rejects a buy-direction request with counterpartyId: 0 (Fix 3: 0 is never a valid carrier_registry id)', async () => {
    const req = new Request('http://localhost/api/negotiation/envelope', {
      method: 'POST', body: JSON.stringify({ direction: 'buy', pipelineLoadId: 1, counterpartyId: 0 }),
    }) as any;
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('accepts a buy-direction request with a real counterpartyId', async () => {
    const req = new Request('http://localhost/api/negotiation/envelope', {
      method: 'POST', body: JSON.stringify({ direction: 'buy', pipelineLoadId: 1, counterpartyId: 7 }),
    }) as any;
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it('ignores a client-supplied tenantId and always uses the authenticated tenant (Fix 5: tenant-isolation regression guard)', async () => {
    (compileEnvelope as any).mockClear();
    const req = new Request('http://localhost/api/negotiation/envelope', {
      method: 'POST',
      body: JSON.stringify({ direction: 'sell', pipelineLoadId: 1, counterpartyId: 0, tenantId: 999 }),
    }) as any;
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(compileEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 2 }),
    );
    const callArg = (compileEnvelope as any).mock.calls[0][0];
    expect(callArg.tenantId).not.toBe(999);
  });
});
