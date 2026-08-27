// __tests__/negotiation/format-helpers.test.ts
import { describe, it, expect } from 'vitest';
import {
  formatPhoneDisplay, formatCurrencyDisplay, formatDateLong,
  timezoneForState, normalizeEquipment, equipmentDisplayName,
} from '@/lib/negotiation/format-helpers';

describe('format-helpers (must match compiler-worker.ts private methods exactly)', () => {
  it('formatPhoneDisplay formats a 10-digit number', () => {
    expect(formatPhoneDisplay('7055551234')).toBe('(705) 555-1234');
  });
  it('formatPhoneDisplay formats an 11-digit number with country code', () => {
    expect(formatPhoneDisplay('17055551234')).toBe('(705) 555-1234');
  });
  it('formatCurrencyDisplay formats whole-dollar CAD', () => {
    expect(formatCurrencyDisplay(2400, 'CAD')).toBe('$2,400');
  });
  it('formatDateLong produces a long weekday/month/ordinal string', () => {
    const d = new Date('2026-04-17T00:00:00Z');
    expect(formatDateLong(d)).toMatch(/^\w+ \w+ \d+(st|nd|rd|th)$/);
  });
  it('timezoneForState maps ON to America/Toronto', () => {
    expect(timezoneForState('', 'ON')).toBe('America/Toronto');
  });
  it('normalizeEquipment maps reefer variants', () => {
    expect(normalizeEquipment('Refrigerated Van')).toBe('reefer');
  });
  it('equipmentDisplayName maps dry_van to "dry van"', () => {
    expect(equipmentDisplayName('Dry Van')).toBe('dry van');
  });
});
