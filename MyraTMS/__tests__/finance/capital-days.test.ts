// __tests__/finance/capital-days.test.ts
//
// Pilot 1 worked-example fixture (T-27 acceptance criteria 1 and 6).
//
// Patrice supplied the four inputs Pilot 1's Financial Architecture §6
// withholds from this repo, hand-verified against the four route outputs:
//
//   Basis: payer owes $2,800 | carrier invoices $2,500 | quick pay discount
//   2.5% | factoring fee 5% | payer collects on day 40
//
//   T1  carrier paid $2,500 day 30    | 10 days  | margin $300.00 | 25,000 c-days   | $12.00/1k
//   T2  carrier paid $2,437.50 day 1  | 39 days  | margin $362.50 | 95,062 c-days   | $3.81/1k
//   T3  carrier paid $2,437.50 day 1  | 1 day    | margin $222.50 | 2,438 c-days    | $91.28/1k
//   T4  carrier paid $2,500 day 30    | -29 days | margin $160.00 | negative        | self-funding
//
// These four (amount, daysHeld, margin) triples are exactly the day-counts
// already given verbatim in the spec's own §1 table (see finding #6 in the
// T-27 completion tracker entry) plus the dollar amounts Patrice hand-derived
// from the basis above. computeCapitalDays()/computeYieldPer1000CapitalDays()
// reproduce all four rows within rounding tolerance — see the assertions
// below. Criteria 1 and 6 are PASS.
import { describe, it, expect } from 'vitest';
import { computeCapitalDays, computeYieldPer1000CapitalDays } from '@/lib/finance/capital-days';

describe('capital-days formula (criteria 1/6 — Pilot 1 worked example)', () => {
  it('T1: carrier paid in full on day 30, 10 days held -> $12.00/1k', () => {
    const { capitalDays, selfFunding } = computeCapitalDays(2500, 10);
    expect(capitalDays).toBeCloseTo(25000, 5);
    expect(selfFunding).toBe(false);
    expect(computeYieldPer1000CapitalDays(300.0, capitalDays)).toBeCloseTo(12.0, 2);
  });

  it('T2: quick-pay carrier paid day 1, 39 days held -> $3.81/1k', () => {
    const { capitalDays, selfFunding } = computeCapitalDays(2437.5, 39);
    expect(capitalDays).toBeCloseTo(95062.5, 5);
    expect(selfFunding).toBe(false);
    expect(computeYieldPer1000CapitalDays(362.5, capitalDays)).toBeCloseTo(3.81, 2);
  });

  it('T3: factored + quick-pay, carrier paid day 1, 1 day held -> $91.28/1k', () => {
    const { capitalDays, selfFunding } = computeCapitalDays(2437.5, 1);
    expect(capitalDays).toBeCloseTo(2437.5, 5);
    expect(selfFunding).toBe(false);
    expect(computeYieldPer1000CapitalDays(222.5, capitalDays)).toBeCloseTo(91.28, 2);
  });

  it('T4: payer collected before carrier was paid, -29 days held -> self-funding, no yield', () => {
    const { capitalDays, selfFunding } = computeCapitalDays(2500, -29);
    expect(capitalDays).toBeCloseTo(-72500, 5);
    expect(selfFunding).toBe(true);
    expect(computeYieldPer1000CapitalDays(160.0, capitalDays)).toBeNull();
  });

  it('flags zero capital-days as self-funding, not a divide-by-zero', () => {
    expect(computeCapitalDays(1000, 0).selfFunding).toBe(true);
    expect(computeYieldPer1000CapitalDays(50, 0)).toBeNull();
  });
});
