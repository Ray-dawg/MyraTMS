// lib/dispatch/routing.ts
//
// T-23 §4.3/§6 — tenant-scoped dispatch mode resolution. Reads
// dispatch_routing_rules as a per-tenant override; falls back to T-19's
// tenant_policies.dispatch_agent_enabled default when no override row
// exists. Resolves only — never acts (T-23b routes a real second tenant
// through in_house_notify; this module doesn't call anything).

import { db } from '@/lib/pipeline/db-adapter';

export type DispatchMode = 'myra_managed' | 'in_house_notify';

export interface DispatchRoutingResolution {
  mode: DispatchMode;
  notifyContact: string | null;
  source: 'override' | 'tenant_policy_default';
}

export async function resolveDispatchRouting(tenantId: number): Promise<DispatchRoutingResolution> {
  const overrideRes = await db.query<{ mode: DispatchMode; notify_contact: string | null }>(
    `SELECT mode, notify_contact FROM dispatch_routing_rules WHERE tenant_id = $1 AND is_active = true`,
    [tenantId],
  );
  if (overrideRes.rows.length > 0) {
    const row = overrideRes.rows[0];
    return { mode: row.mode, notifyContact: row.notify_contact, source: 'override' };
  }

  const policyRes = await db.query<{ dispatch_agent_enabled: boolean }>(
    `SELECT dispatch_agent_enabled FROM tenant_policies
      WHERE tenant_id = $1 AND is_active = true
      ORDER BY version DESC LIMIT 1`,
    [tenantId],
  );
  const enabled = policyRes.rows[0]?.dispatch_agent_enabled ?? false;
  return { mode: enabled ? 'myra_managed' : 'in_house_notify', notifyContact: null, source: 'tenant_policy_default' };
}

export async function setDispatchRoutingOverride(
  tenantId: number,
  mode: DispatchMode,
  notifyContact: string | null,
): Promise<void> {
  if (mode === 'in_house_notify' && !notifyContact) {
    throw new Error('notifyContact is required when mode=in_house_notify');
  }
  await db.query(
    `INSERT INTO dispatch_routing_rules (tenant_id, mode, notify_contact, is_active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (tenant_id) DO UPDATE SET mode = EXCLUDED.mode, notify_contact = EXCLUDED.notify_contact, is_active = true`,
    [tenantId, mode, notifyContact],
  );
}
