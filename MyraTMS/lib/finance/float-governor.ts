//
// T-27 §2/§7 criterion 3 — the piece Pilot 1's own checklist named as not
// yet built. v_float_exposure (migration 057) is computed live, same
// reasoning as T-25's v_payer_concentration_exposure: a stale float number
// defeats the point of a governor.
import { db } from '@/lib/pipeline/db-adapter';

export interface FloatExposure {
  tenantId: number;
  currentFloatUsd: number;
  floatCapUsd: number | null;
}

export async function getFloatExposure(tenantId: number): Promise<FloatExposure> {
  const { rows } = await db.query<{ tenant_id: string; current_float_usd: string; float_cap_usd: string | null }>(
    `SELECT tenant_id, current_float_usd, float_cap_usd FROM v_float_exposure WHERE tenant_id = $1`,
    [tenantId],
  );
  if (rows.length === 0) {
    return { tenantId, currentFloatUsd: 0, floatCapUsd: null };
  }
  return {
    tenantId,
    currentFloatUsd: Number(rows[0].current_float_usd),
    floatCapUsd: rows[0].float_cap_usd === null ? null : Number(rows[0].float_cap_usd),
  };
}

// A null cap means Myra hasn't set float_cap_usd yet (§4.1 — depends on the
// facility being papered by counsel, an explicit non-engineering
// prerequisite). Until it's set, nothing is enforced — T1/T2 stay
// selectable. This is a deliberate default, not a bug: enforcing an
// unconfigured cap of zero would force every load to DECLINE or T3.
export function isFloatCapacityAvailable(exposure: FloatExposure, projectedAmount: number): boolean {
  if (exposure.floatCapUsd === null) return true;
  return exposure.currentFloatUsd + projectedAmount <= exposure.floatCapUsd;
}
