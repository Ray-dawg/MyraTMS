// lib/documents/__tests__/rate-con-terms.test.ts
import { describe, it, expect } from 'vitest';
import { compareTerms, extractRateConTerms } from '@/lib/documents/rate-con-terms';

const NEGOTIATED = { rate: 2400, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' };

describe('compareTerms (acceptance criterion 3 — seeded cases)', () => {
  it('returns unparseable when extraction failed', () => {
    expect(compareTerms(null, NEGOTIATED)).toBe('unparseable');
  });

  it('returns match when rate/lane/date all agree (rate within $1 tolerance)', () => {
    expect(compareTerms({ rate: 2400.5, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' }, NEGOTIATED)).toBe('match');
  });

  it('returns mismatch when the rate differs', () => {
    expect(compareTerms({ rate: 2600, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' }, NEGOTIATED)).toBe('mismatch');
  });

  it('returns mismatch when the lane differs', () => {
    expect(compareTerms({ rate: 2400, origin: 'Toronto', destination: 'Ottawa', pickupDate: '2026-09-01' }, NEGOTIATED)).toBe('mismatch');
  });

  it('returns mismatch when the pickup date differs', () => {
    expect(compareTerms({ rate: 2400, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-02' }, NEGOTIATED)).toBe('mismatch');
  });

  it('zero false positives on 5 matched-rate test cases (criterion 3)', () => {
    const matches = [
      { rate: 2400, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' },
      { rate: 2399.5, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' },
      { rate: 2400.99, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' },
      { rate: 2400, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' },
      { rate: 2400, origin: 'Toronto', destination: 'Sudbury', pickupDate: '2026-09-01' },
    ];
    for (const m of matches) expect(compareTerms(m, NEGOTIATED)).toBe('match');
  });
});

describe('extractRateConTerms', () => {
  it('returns null (never throws) when ANTHROPIC_API_KEY is missing', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const result = await extractRateConTerms(Buffer.from('fake-pdf-bytes'));
    expect(result).toBeNull();
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
  });
});
