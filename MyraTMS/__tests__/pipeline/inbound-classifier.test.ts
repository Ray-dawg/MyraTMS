import { describe, it, expect } from 'vitest';
import { classifyInboundEmail } from '@/lib/email/inbound-classifier';

describe('classifyInboundEmail (E2-04 M4)', () => {
  it('classifies a shipper confirmation-request reply', () => {
    const result = classifyInboundEmail('Rate Confirmation Needed — Load DAT-12345');
    expect(result).toEqual({ type: 'shipper_reply', loadId: 'DAT-12345' });
  });

  it('classifies a shipper reply with a "Re:" prefix', () => {
    const result = classifyInboundEmail('Re: Rate Confirmation Needed — Load DAT-12345');
    expect(result).toEqual({ type: 'shipper_reply', loadId: 'DAT-12345' });
  });

  it('classifies a shipper reply to the nudge variant', () => {
    const result = classifyInboundEmail('Re: Reminder: Rate Confirmation Needed — Load DAT-12345');
    expect(result).toEqual({ type: 'shipper_reply', loadId: 'DAT-12345' });
  });

  it('classifies a shipper reply with a repeated "Fwd: Re:" prefix', () => {
    const result = classifyInboundEmail('Fwd: Re: Fwd: Rate Confirmation Needed — Load DAT-99');
    expect(result).toEqual({ type: 'shipper_reply', loadId: 'DAT-99' });
  });

  it('classifies a shipper reply with a plain-hyphen subject (some clients normalize the em-dash)', () => {
    const result = classifyInboundEmail('Rate Confirmation Needed - Load DAT-12345');
    expect(result).toEqual({ type: 'shipper_reply', loadId: 'DAT-12345' });
  });

  it('classifies a carrier rate-con reply', () => {
    const result = classifyInboundEmail('Rate Confirmation — LD-ABC123');
    expect(result).toEqual({ type: 'carrier_reply', loadReference: 'LD-ABC123' });
  });

  it('classifies a carrier reply with a "Re:" prefix', () => {
    const result = classifyInboundEmail('Re: Rate Confirmation — LD-ABC123');
    expect(result).toEqual({ type: 'carrier_reply', loadReference: 'LD-ABC123' });
  });

  it('does not confuse a shipper subject for a carrier one', () => {
    const result = classifyInboundEmail('Rate Confirmation Needed — Load DAT-12345');
    expect(result.type).toBe('shipper_reply');
  });

  it('returns unmatched for an unrelated subject', () => {
    const result = classifyInboundEmail('Out of office');
    expect(result).toEqual({ type: 'unmatched' });
  });

  it('returns unmatched for a null/empty subject', () => {
    expect(classifyInboundEmail(null)).toEqual({ type: 'unmatched' });
    expect(classifyInboundEmail(undefined)).toEqual({ type: 'unmatched' });
    expect(classifyInboundEmail('')).toEqual({ type: 'unmatched' });
  });
});
