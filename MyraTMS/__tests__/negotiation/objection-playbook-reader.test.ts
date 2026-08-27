import { describe, it, expect } from 'vitest';
import { getObjectionPlaybook } from '@/lib/negotiation/objection-playbook';

describe('getObjectionPlaybook', () => {
  it('returns only shipper-tagged entries for counterpartyType=shipper', async () => {
    const entries = await getObjectionPlaybook('shipper', []);
    expect(entries.length).toBe(9);
    expect(entries.every((e) => e.objectionType !== 'rate_too_low')).toBe(true);
  });

  it('returns only carrier-tagged entries for counterpartyType=carrier', async () => {
    const entries = await getObjectionPlaybook('carrier', []);
    expect(entries.length).toBe(5);
    expect(entries.some((e) => e.objectionType === 'rate_too_low')).toBe(true);
  });

  it('sorts known objections first', async () => {
    const entries = await getObjectionPlaybook('shipper', ['already_have_carrier']);
    expect(entries[0].objectionType).toBe('already_have_carrier');
  });
});
