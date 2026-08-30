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
  return (rows[0]?.credit_level as PayerCreditLevel) ?? 'unknown';
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
