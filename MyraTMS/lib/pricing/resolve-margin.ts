/**
 * T-21 §4.2 — tenant-aware margin resolution. Pulls margin_floor_pct from
 * T-19's tenant_policies when a tenant has an active override; falls back to
 * Myra's existing hardcoded constants (lib/pipeline/cost-calculator.ts's
 * getMarginThresholds()) otherwise, so Myra's own pricing behavior is
 * provably unchanged (§7 acceptance criterion 3).
 *
 * Interpretation note (spec ambiguity, not silently guessed): the spec's
 * computeMarginFromPct(pct, currency) has no cost/revenue parameter to scale
 * against — resolveMargin()'s own signature is (tenantId, currency) only.
 * With no base amount available, margin_floor_pct is read as "this tenant's
 * margin thresholds as a percentage of Myra's own default thresholds for
 * that currency" (a multiplier), not "percentage of this load's cost" (which
 * would require passing cost.total in, contradicting the spec's own
 * signature). Documented here so a future session can revisit if the
 * intended reading turns out to be something else once a real non-Myra
 * tenant sets this field.
 */

import { db } from '@/lib/pipeline/db-adapter';
import { getMarginThresholds } from '@/lib/pipeline/cost-calculator';

export interface MarginConfig {
  minMargin: number;
  targetMargin: number;
  stretchMargin: number;
}

export type MarginSource = 'tenant_override' | 'myra_default';

export interface MarginResolution {
  margin: MarginConfig;
  source: MarginSource;
}

function myraDefault(currency: 'CAD' | 'USD'): MarginConfig {
  const t = getMarginThresholds(currency);
  return { minMargin: t.floor, targetMargin: t.target, stretchMargin: t.stretch };
}

function computeMarginFromPct(pct: number, currency: 'CAD' | 'USD'): MarginConfig {
  const base = myraDefault(currency);
  const factor = pct / 100;
  return {
    minMargin: Math.round(base.minMargin * factor * 100) / 100,
    targetMargin: Math.round(base.targetMargin * factor * 100) / 100,
    stretchMargin: Math.round(base.stretchMargin * factor * 100) / 100,
  };
}

export async function resolveMargin(tenantId: number, currency: 'CAD' | 'USD'): Promise<MarginResolution> {
  const r = await db.query<{ margin_floor_pct: string | null }>(
    `SELECT margin_floor_pct FROM tenant_policies WHERE tenant_id = $1 AND is_active = true ORDER BY version DESC LIMIT 1`,
    [tenantId],
  );

  const pct = r.rows[0]?.margin_floor_pct != null ? Number(r.rows[0].margin_floor_pct) : null;
  if (pct != null) {
    return { margin: computeMarginFromPct(pct, currency), source: 'tenant_override' };
  }
  return { margin: myraDefault(currency), source: 'myra_default' };
}
