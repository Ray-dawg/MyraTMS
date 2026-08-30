//
// Treasury report over financing_decisions — capital-days and
// yield-per-1000-capital-days, using the placeholder formula in
// capital-days.ts. NOT verified against Pilot 1's real Financial
// Architecture numbers — acceptance criteria 1 and 6 remain OPEN. This
// report reflects real financing_decisions rows only, never invented ones.
import { db } from '@/lib/pipeline/db-adapter';

export interface TreasuryReport {
  tenantId: number;
  decisionCount: number;
  totalCapitalDaysProjected: number;
  averageYieldProjected: number | null;
  routeCounts: Record<string, number>;
  note: string;
}

export async function getTreasuryReport(tenantId: number): Promise<TreasuryReport> {
  const { rows } = await db.query<{
    route_selected: string;
    capital_days_projected: string | null;
    yield_projected: string | null;
  }>(
    `SELECT route_selected, capital_days_projected, yield_projected
       FROM financing_decisions WHERE tenant_id = $1`,
    [tenantId],
  );

  const routeCounts: Record<string, number> = {};
  let totalCapitalDays = 0;
  let yieldSum = 0;
  let yieldCount = 0;

  for (const row of rows) {
    routeCounts[row.route_selected] = (routeCounts[row.route_selected] ?? 0) + 1;
    if (row.capital_days_projected !== null) totalCapitalDays += Number(row.capital_days_projected);
    if (row.yield_projected !== null) {
      yieldSum += Number(row.yield_projected);
      yieldCount += 1;
    }
  }

  return {
    tenantId,
    decisionCount: rows.length,
    totalCapitalDaysProjected: totalCapitalDays,
    averageYieldProjected: yieldCount === 0 ? null : yieldSum / yieldCount,
    routeCounts,
    note: "Uses a placeholder capital-days/yield formula, not verified against Pilot 1's real Financial Architecture numbers ($12.00/$3.81/$91.28/self-funding) — see the T-27 completion tracker entry for the missing-document finding.",
  };
}
