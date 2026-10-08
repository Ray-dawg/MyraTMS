import { describe, it, expect } from 'vitest';
import { getShipperDirectGateMode, getGateEnforcedAt } from '@/lib/pipeline/gate-mode';

describe('getShipperDirectGateMode', () => {
  it('is off unless SHIPPER_DIRECT_GATE_ENABLED=true', () => {
    expect(getShipperDirectGateMode({})).toBe('off');
    expect(getShipperDirectGateMode({ SHIPPER_DIRECT_GATE_ENABLED: 'false', SHIPPER_DIRECT_GATE_MODE: 'enforce' })).toBe('off');
  });
  it('defaults to shadow when enabled without a mode', () => {
    expect(getShipperDirectGateMode({ SHIPPER_DIRECT_GATE_ENABLED: 'true' })).toBe('shadow');
  });
  it('enforces only on the exact word, trimmed and lowercased', () => {
    expect(getShipperDirectGateMode({ SHIPPER_DIRECT_GATE_ENABLED: ' TRUE\n', SHIPPER_DIRECT_GATE_MODE: ' Enforce ' })).toBe('enforce');
    expect(getShipperDirectGateMode({ SHIPPER_DIRECT_GATE_ENABLED: 'true', SHIPPER_DIRECT_GATE_MODE: 'enforced' })).toBe('shadow');
  });
});

describe('getGateEnforcedAt', () => {
  it('parses an ISO timestamp and returns null for garbage', () => {
    expect(getGateEnforcedAt({ SHIPPER_DIRECT_GATE_ENFORCED_AT: '2026-11-01T00:00:00Z' })?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(getGateEnforcedAt({ SHIPPER_DIRECT_GATE_ENFORCED_AT: 'soon' })).toBeNull();
    expect(getGateEnforcedAt({})).toBeNull();
  });
});
