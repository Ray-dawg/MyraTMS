// lib/finance/capital-days.ts
//
// PLACEHOLDER FORMULA — NOT verified against Pilot 1's real Financial
// Architecture document (§6), which does not exist anywhere in this
// repository (searched Engine 2/, Engine 3/, and all root-level .docx
// files). Do not claim these numbers reproduce Pilot 1's worked example
// ($12.00 / $3.81 / $91.28 / self-funding). T-27 acceptance criteria 1 and
// 6 are OPEN pending that document — see the T-27 completion tracker entry.
// Tested only for internal consistency (sign handling, zero handling).
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
