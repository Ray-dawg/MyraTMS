// lib/risk/payer-credit.ts
//
// T-25 §4.2/criterion 2 — a payer with no row here is 'unknown' by
// definition; per Pilot 1's own rule, unknown credit is flagged regardless
// of margin, not treated as neutral.

import { db } from '@/lib/pipeline/db-adapter';

export interface PayerCreditStatus {
  creditLevel: string;
  flagged: boolean;
  reason: string;
}

export async function getPayerCreditStatus(payerRegistryId: number): Promise<PayerCreditStatus> {
  const { rows } = await db.query<{ credit_level: string }>(
    `SELECT credit_level FROM payer_credit_assessments
      WHERE payer_registry_id = $1 ORDER BY assessed_at DESC LIMIT 1`,
    [payerRegistryId],
  );

  if (rows.length === 0) {
    return { creditLevel: 'unknown', flagged: true, reason: 'No credit assessment on file.' };
  }

  const creditLevel = rows[0].credit_level;
  const flagged = creditLevel === 'unknown' || creditLevel === 'weak';
  return { creditLevel, flagged, reason: flagged ? `Credit level is '${creditLevel}'.` : `Credit level is '${creditLevel}' — no flag.` };
}

const DEFAULT_CONCENTRATION_CAP_PCT = 25;

export async function getConcentrationCap(tenantId: number): Promise<number> {
  const { rows } = await db.query<{ concentration_cap_pct: string | null }>(
    `SELECT concentration_cap_pct FROM tenant_policies
      WHERE tenant_id = $1 AND is_active = true ORDER BY version DESC LIMIT 1`,
    [tenantId],
  );
  const raw = rows[0]?.concentration_cap_pct;
  return raw != null ? Number(raw) : DEFAULT_CONCENTRATION_CAP_PCT;
}
