// T-27 §5 inputs, sourced from real tables rather than assumed fields.
// payerCreditLevel comes from T-25's payer_credit_assessments, joined via
// pipeline_loads.payer_registry_id (T-25's linkage column — pipeline_loads
// has no direct FK to payer_credit_assessments, so this is a point-in-time
// lookup of the latest assessment, not a live join).
// carrierWantsQuickPay comes from carrier_registry.payment_preference (new
// in migration 057 — carriers.payment_preference, which the base spec
// assumed, does not exist), joined via pipeline_loads.top_carrier_id ->
// carriers.carrier_registry_id.
import { db } from '@/lib/pipeline/db-adapter';
import type { PayerCreditLevel } from './routing';

// payer_credit_assessments.credit_level is a plain VARCHAR(20) with no CHECK
// constraint, so the database can hand back any string — a future vocabulary
// addition, a typo, or a value written by a different module. Blind-casting it
// to PayerCreditLevel fails OPEN: decideRoute() only DECLINEs on exactly
// 'weak'/'unknown', so an unrecognized level would fall through to T1/T2/T3
// and get financed. T-27 §3.2 is explicit that finance mistakes are not
// reversible by inaction, so anything unrecognized collapses to the same
// conservative 'unknown' default already used when no row exists at all.
const PAYER_CREDIT_LEVELS: readonly PayerCreditLevel[] = ['unknown', 'weak', 'acceptable', 'strong'];

function toPayerCreditLevel(value: string | null | undefined): PayerCreditLevel {
  return PAYER_CREDIT_LEVELS.includes(value as PayerCreditLevel)
    ? (value as PayerCreditLevel)
    : 'unknown';
}

export async function getPayerCreditLevel(pipelineLoadId: number): Promise<PayerCreditLevel> {
  const { rows } = await db.query<{ credit_level: string }>(
    `SELECT pca.credit_level
       FROM pipeline_loads pl
       JOIN payer_credit_assessments pca ON pca.payer_registry_id = pl.payer_registry_id
      WHERE pl.id = $1
      ORDER BY pca.assessed_at DESC
      LIMIT 1`,
    [pipelineLoadId],
  );
  return toPayerCreditLevel(rows[0]?.credit_level);
}

export async function getCarrierWantsQuickPay(pipelineLoadId: number): Promise<boolean> {
  const { rows } = await db.query<{ payment_preference: string | null }>(
    `SELECT cr.payment_preference
       FROM pipeline_loads pl
       JOIN carriers c ON c.id = pl.top_carrier_id
       JOIN carrier_registry cr ON cr.id = c.carrier_registry_id
      WHERE pl.id = $1`,
    [pipelineLoadId],
  );
  return rows[0]?.payment_preference === 'quick_pay';
}
