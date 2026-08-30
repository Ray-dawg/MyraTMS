// __tests__/finance/capital-days.test.ts
//
// These tests check INTERNAL CONSISTENCY only (sign handling, zero
// handling) — they do NOT assert the formula matches Pilot 1's real
// worked example ($12.00/$3.81/$91.28/self-funding). That document does
// not exist in this repository. Acceptance criteria 1 and 6 are OPEN.
import { describe, it, expect } from 'vitest';
import { computeCapitalDays, computeYieldPer1000CapitalDays } from '@/lib/finance/capital-days';

describe('capital-days placeholder formula (criteria 1/6 OPEN — see plan Global Constraints)', () => {
  it('computes positive capital-days for a load held before collection', () => {
    const result = computeCapitalDays(1000, 10);
    expect(result.capitalDays).toBe(10000);
    expect(result.selfFunding).toBe(false);
  });

  it('flags zero or negative capital-days as self-funding (T4-style: factored before net-30 would have paid)', () => {
    expect(computeCapitalDays(1000, -29).selfFunding).toBe(true);
    expect(computeCapitalDays(1000, 0).selfFunding).toBe(true);
  });

  it('returns null yield for self-funding cases rather than a divide-by-zero or negative number', () => {
    expect(computeYieldPer1000CapitalDays(50, 0)).toBeNull();
    expect(computeYieldPer1000CapitalDays(50, -10000)).toBeNull();
  });

  it('computes a positive yield for positive capital-days', () => {
    expect(computeYieldPer1000CapitalDays(120, 10000)).toBeCloseTo(12, 5);
  });
});
