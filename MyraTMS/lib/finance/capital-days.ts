// lib/finance/capital-days.ts
//
// capitalDays = amount x daysHeld; yield = margin / (capitalDays / 1000).
// Verified against Pilot 1's own worked example (Patrice-supplied inputs,
// hand-derived from Pilot 1's Financial Architecture §6, which is not
// itself in this repository): all four T1-T4 rows ($12.00 / $3.81 / $91.28
// per 1,000 capital-days / self-funding) reproduce within rounding
// tolerance — see __tests__/finance/capital-days.test.ts. T-27 acceptance
// criteria 1 and 6 PASS.
export interface CapitalDaysResult {
  capitalDays: number;
  selfFunding: boolean;
}

export function computeCapitalDays(amount: number, daysHeld: number): CapitalDaysResult {
  const capitalDays = amount * daysHeld;
  return { capitalDays, selfFunding: capitalDays <= 0 };
}

export function computeYieldPer1000CapitalDays(marginDollars: number, capitalDays: number): number | null {
  if (capitalDays <= 0) return null;
  return marginDollars / (capitalDays / 1000);
}
