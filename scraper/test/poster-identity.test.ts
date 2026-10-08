import { describe, it, expect } from 'vitest';
import { normalizeIdNumber, posterFromRawLoad, normalizeCompanyName } from '../src/pipeline/poster-identity.js';

describe('normalizeIdNumber', () => {
  it('strips prefixes and punctuation to digits', () => {
    expect(normalizeIdNumber('MC-123456')).toBe('123456');
    expect(normalizeIdNumber('USDOT 2,345,678')).toBe('2345678');
  });
  it('returns null for empty or non-numeric input', () => {
    expect(normalizeIdNumber('')).toBeNull();
    expect(normalizeIdNumber('n/a')).toBeNull();
    expect(normalizeIdNumber(undefined)).toBeNull();
  });
});

describe('posterFromRawLoad', () => {
  it('prefers explicit poster fields over shipperCompany', () => {
    expect(posterFromRawLoad({ shipperCompany: 'X', posterCompanyRaw: 'Acme Logistics Inc.', posterMcNumber: 'MC-1', posterDotNumber: null }))
      .toEqual({ posterCompanyRaw: 'Acme Logistics Inc.', posterMcNumber: '1', posterDotNumber: null });
  });
  it('falls back to shipperCompany when no poster company is given', () => {
    expect(posterFromRawLoad({ shipperCompany: 'Northern Mine Supply' }))
      .toEqual({ posterCompanyRaw: 'Northern Mine Supply', posterMcNumber: null, posterDotNumber: null });
  });
});

describe('normalizeCompanyName', () => {
  it('matches the MyraTMS classifier normalization', () => {
    expect(normalizeCompanyName('Acme Logistics Inc.')).toBe('acme logistics');
  });
});
