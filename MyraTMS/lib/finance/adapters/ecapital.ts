// lib/finance/adapters/ecapital.ts
//
// Sandbox-only stub — no real eCapital API credentials are wired in this
// build (T-27 §10: production credentials must never be wired in this
// session). `environment` is typed as the literal 'sandbox', not `string`,
// so no code path in this file can produce 'production' without a compile
// error. The INSERT below also hardcodes the SQL literal 'sandbox' rather
// than binding it as a parameter — belt-and-suspenders for criterion 4.
import { db } from '@/lib/pipeline/db-adapter';

export interface FactoringSubmissionResult {
  environment: 'sandbox';
  ecapitalReferenceId: string;
  status: 'Submitted';
  advanceRate: number;
  feePct: number;
}

export function submitToEcapitalSandbox(feePct: number): FactoringSubmissionResult {
  return {
    environment: 'sandbox',
    ecapitalReferenceId: `SANDBOX-ECAP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    status: 'Submitted',
    advanceRate: 100 - feePct,
    feePct,
  };
}

export async function recordFactoringSubmission(
  pipelineLoadId: number,
  result: FactoringSubmissionResult,
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO factoring_submissions
       (pipeline_load_id, ecapital_reference_id, status, advance_rate, fee_pct, submitted_at, environment)
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, 'sandbox')
     RETURNING id`,
    [pipelineLoadId, result.ecapitalReferenceId, result.status, result.advanceRate, result.feePct],
  );
  return rows[0].id;
}
