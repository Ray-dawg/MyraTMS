// lib/risk/double-broker-crosscheck.ts
//
// T-25 §2/criterion 5 — defense-in-depth: did any load T-19's
// evaluatePolicy() would reject under Myra's shipper_direct_or_coBroker
// policy (load_source_class='broker_posted', meaning no active co-broker
// agreement was found) actually get booked anyway. Read-only report.
// pipeline_loads.load_source_class is 100% NULL in production today (the
// shadow gate has never classified a real load) — this correctly reports
// zero matches right now, an honest reflection of shadow-only enforcement,
// not a validated true negative.

import { db } from '@/lib/pipeline/db-adapter';

export interface CrossCheckResult {
  checked: number;
  flagged: { pipelineLoadId: number; loadId: string }[];
}

export async function runDoubleBrokerCrossCheck(sinceDays: number): Promise<CrossCheckResult> {
  const { rows } = await db.query<{ id: number; load_id: string; load_source_class: string | null }>(
    `SELECT id, load_id, load_source_class FROM pipeline_loads
      WHERE stage IN ('booked', 'dispatched', 'delivered')
        AND created_at > NOW() - ($1 || ' days')::interval`,
    [sinceDays],
  );

  const flagged = rows
    .filter((r) => r.load_source_class === 'broker_posted')
    .map((r) => ({ pipelineLoadId: r.id, loadId: r.load_id }));

  return { checked: rows.length, flagged };
}
