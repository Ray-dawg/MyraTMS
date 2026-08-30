// lib/finance/adapters/stripe.ts
import { db } from '@/lib/pipeline/db-adapter';

export interface QuickPayDisbursementResult {
  environment: 'sandbox';
  stripeTransferId: string;
  status: 'pending';
  discountApplied: number;
}

export function disburseQuickPaySandbox(amount: number, discountPct: number): QuickPayDisbursementResult {
  return {
    environment: 'sandbox',
    stripeTransferId: `SANDBOX-STRIPE-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    status: 'pending',
    discountApplied: Math.round(amount * (discountPct / 100) * 100) / 100,
  };
}

export async function recordQuickPayDisbursement(
  pipelineLoadId: number,
  carrierRegistryId: number,
  amount: number,
  result: QuickPayDisbursementResult,
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO quick_pay_disbursements
       (pipeline_load_id, carrier_registry_id, amount, discount_applied, stripe_transfer_id, status, disbursed_at, environment)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, 'sandbox')
     RETURNING id`,
    [pipelineLoadId, carrierRegistryId, amount, result.discountApplied, result.stripeTransferId, result.status],
  );
  return rows[0].id;
}
