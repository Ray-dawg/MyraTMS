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

// The two halves of a float exposure come from independent sources on purpose.
//
// v_float_exposure is defined `FROM financing_decisions fd JOIN pipeline_loads
// ... JOIN tenant_policies ...` (migration 057), so it yields ZERO rows for a
// tenant that has never recorded a financing decision — including on that
// tenant's very first load. Reading float_cap_usd from that view therefore made
// a configured cap unenforceable exactly when it matters most: the cap came
// back null, and isFloatCapacityAvailable() reads null as "unlimited". The cap
// is now read straight from tenant_policies, which does not depend on any
// financing_decisions row existing.
//
// The tenant_policies read follows the same convention every other Engine 3
// module uses (lib/pricing/resolve-margin.ts, lib/dispatch/routing.ts,
// lib/risk/payer-credit.ts): tenant_policies only has UNIQUE(tenant_id,
// version), so nothing stops two rows being is_active at once — ORDER BY
// version DESC LIMIT 1 makes the winner deterministic instead of arbitrary.
//
// The two queries are independent, so they run concurrently.
export async function getFloatExposure(tenantId: number): Promise<FloatExposure> {
  const [exposureRes, policyRes] = await Promise.all([
    db.query<{ tenant_id: string; current_float_usd: string | null }>(
      `SELECT tenant_id, current_float_usd FROM v_float_exposure WHERE tenant_id = $1`,
      [tenantId],
    ),
    db.query<{ float_cap_usd: string | null }>(
      `SELECT (treasury_policy->>'float_cap_usd')::numeric AS float_cap_usd
         FROM tenant_policies
        WHERE tenant_id = $1 AND is_active = true
        ORDER BY version DESC
        LIMIT 1`,
      [tenantId],
    ),
  ]);

  const currentRaw = exposureRes.rows[0]?.current_float_usd;
  const capRaw = policyRes.rows[0]?.float_cap_usd;

  return {
    tenantId,
    currentFloatUsd: currentRaw == null ? 0 : Number(currentRaw),
    floatCapUsd: capRaw == null ? null : Number(capRaw),
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
