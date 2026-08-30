// lib/tenants/provision.ts
//
// Shared tenant-provisioning functions. Extracted so app/api/admin/tenants/
// route.ts and .../[id]/onboard/route.ts (the existing, already-shipped
// super-admin tenant tooling) and T-28's new self-serve session flow call
// the SAME code — see design doc §1/§3.2 for why this extraction exists
// instead of two independent implementations.

import { DEFAULT_TENANT_CONFIG } from './defaults';
import { assertValidTenantSlug } from './validators';

export type Queryable = {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export interface CreateTenantInput {
  slug: string;
  name: string;
  type: 'operating_company' | 'saas_customer' | 'internal';
  freightBusinessType?: 'broker' | 'dispatcher' | 'carrier' | 'acquired_opco' | null;
  parentTenantId?: number | null;
  billingEmail?: string | null;
  status?: string;
}

export async function createTenantRow(
  q: Queryable,
  input: CreateTenantInput,
): Promise<{ tenantId: number; createdAt: string }> {
  const slug = input.slug.trim().toLowerCase();
  assertValidTenantSlug(slug);

  const { rows: existing } = await q.query<{ id: number }>(
    `SELECT id FROM tenants WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  if (existing.length > 0) {
    throw new Error(`Tenant slug '${slug}' already exists`);
  }

  const { rows } = await q.query<{ id: number; created_at: string }>(
    `INSERT INTO tenants (slug, name, type, freight_business_type, parent_tenant_id, billing_email, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [
      slug, input.name, input.type, input.freightBusinessType ?? null,
      input.parentTenantId ?? null, input.billingEmail ?? null, input.status ?? 'trial',
    ],
  );
  return { tenantId: rows[0].id, createdAt: rows[0].created_at };
}

export async function cloneDefaultTenantConfig(
  q: Queryable,
  tenantId: number,
): Promise<{ configRowsAdded: number }> {
  const { rows: existingConfig } = await q.query<{ key: string }>(
    `SELECT key FROM tenant_config WHERE tenant_id = $1`,
    [tenantId],
  );
  const existingKeys = new Set(existingConfig.map((r) => r.key));

  let configRowsAdded = 0;
  for (const def of DEFAULT_TENANT_CONFIG) {
    if (existingKeys.has(def.key)) continue;
    await q.query(
      `INSERT INTO tenant_config (tenant_id, key, value, encrypted, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, NOW(), $5)`,
      [tenantId, def.key, JSON.stringify(def.value), def.encrypted, 'system:t28-provision'],
    );
    configRowsAdded++;
  }
  return { configRowsAdded };
}

export async function seatTenantOwner(
  q: Queryable,
  tenantId: number,
  userId: string,
): Promise<{ ownerSeated: boolean }> {
  const { rows: existingMembership } = await q.query(
    `SELECT user_id FROM tenant_users WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
    [tenantId, userId],
  );
  if (existingMembership.length > 0) {
    return { ownerSeated: false };
  }
  await q.query(
    `UPDATE tenant_users SET is_primary = false WHERE user_id = $1 AND is_primary = true`,
    [userId],
  );
  await q.query(
    `INSERT INTO tenant_users (tenant_id, user_id, role, is_primary, joined_at)
     VALUES ($1, $2, 'owner', true, NOW())`,
    [tenantId, userId],
  );
  return { ownerSeated: true };
}

/** Maps a template's dispatch_agent_default vocabulary onto tenant_policies'
 *  boolean column. 'on' -> true, 'opt_in' -> false (off by default, tenant
 *  can enable later), 'inherit' has no defined resolution anywhere in this
 *  codebase (T-19 never built it either) -- rejected outright rather than
 *  guessed.
 *
 *  Idempotent: `tenant_policies` has UNIQUE (tenant_id, version), so a
 *  second call deactivates the tenant's current active row and inserts the
 *  next version rather than re-using version 1 (mirrors resolveDispatchRouting's
 *  `ORDER BY version DESC LIMIT 1` read pattern in lib/dispatch/routing.ts —
 *  versions accumulate, they don't collide). Also ensures the 'policy_engine'
 *  authority_envelopes shell row this tenant needs exists, generalizing the
 *  one-time Myra-only pairing migration 035 set up (tenant_policies row +
 *  envelope shell together) off `tenantId` instead of `fn_myra_tenant_id()` —
 *  evaluatePolicy() hard-throws without it. */
export async function applyTenantTypePolicyTemplate(
  q: Queryable,
  tenantId: number,
  freightBusinessType: 'broker' | 'dispatcher' | 'carrier',
): Promise<{ policyId: number }> {
  if ((freightBusinessType as string) === 'acquired_opco') {
    throw new Error(
      "applyTenantTypePolicyTemplate: 'acquired_opco' uses 'inherit' semantics that are not resolved anywhere in this codebase — pass the acquired entity's actual broker/dispatcher/carrier type instead.",
    );
  }
  const { rows: templateRows } = await q.query<{
    load_source_policy: string; dispatch_agent_default: string; negotiation_directions: string;
  }>(
    `SELECT load_source_policy, dispatch_agent_default, negotiation_directions
       FROM tenant_type_policy_templates WHERE freight_business_type = $1`,
    [freightBusinessType],
  );
  if (templateRows.length === 0) {
    throw new Error(`No tenant_type_policy_templates row for freight_business_type='${freightBusinessType}'`);
  }
  const template = templateRows[0];
  const dispatchAgentEnabled = template.dispatch_agent_default === 'on';

  await q.query(`UPDATE tenants SET freight_business_type = $1 WHERE id = $2`, [freightBusinessType, tenantId]);

  // Deactivate any existing active row, then insert the next version —
  // keeps at most one active row per tenant and never collides on
  // UNIQUE (tenant_id, version).
  await q.query(
    `UPDATE tenant_policies SET is_active = false WHERE tenant_id = $1 AND is_active = true`,
    [tenantId],
  );
  const { rows: versionRows } = await q.query<{ next_version: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM tenant_policies WHERE tenant_id = $1`,
    [tenantId],
  );
  const nextVersion = versionRows[0].next_version;

  const { rows } = await q.query<{ id: number }>(
    `INSERT INTO tenant_policies (tenant_id, version, load_source_policy, dispatch_agent_enabled, negotiation_directions, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, true, 'system:t28-provision')
     RETURNING id`,
    [tenantId, nextVersion, template.load_source_policy, dispatchAgentEnabled, template.negotiation_directions],
  );

  // Ensure this tenant has a 'policy_engine' authority_envelopes shell row —
  // same shape as migration 035's Myra-only seed, generalized off tenantId.
  // Without it, evaluatePolicy() (lib/governance/evaluate-policy-db.ts)
  // hard-throws "no active envelope for 'policy_engine' on tenant_id=X".
  const { rows: agentRows } = await q.query<{ id: number }>(
    `SELECT id FROM agents WHERE agent_key = 'policy_engine'`,
  );
  if (agentRows.length === 0) {
    throw new Error("applyTenantTypePolicyTemplate: 'policy_engine' agent not seeded — run migration 035");
  }
  const policyEngineAgentId = agentRows[0].id;

  await q.query(
    `INSERT INTO authority_envelopes (
       agent_id, tenant_id, version, envelope_name, permissions, tools, budget, policies,
       confidence_threshold, autonomy_default, escalation_rules, created_by
     )
     SELECT $1, $2, 1, $3,
            '{"can": ["evaluate_load_source_policy"], "cannot": []}'::jsonb,
            '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, 0.700, 'L2', '[]'::jsonb, 'system:t28-provision'
     WHERE NOT EXISTS (
       SELECT 1 FROM authority_envelopes WHERE agent_id = $1 AND tenant_id = $2
     )`,
    [policyEngineAgentId, tenantId, `policy-engine-tenant-${tenantId}-default`],
  );

  return { policyId: rows[0].id };
}

export async function captureBillingIntent(
  q: Queryable,
  tenantId: number,
  tier: 'starter' | 'pro' | 'enterprise',
): Promise<void> {
  await q.query(
    `INSERT INTO tenant_subscriptions (tenant_id, tier, status)
     VALUES ($1, $2, 'trial')
     ON CONFLICT (tenant_id) DO UPDATE SET tier = EXCLUDED.tier, updated_at = NOW()`,
    [tenantId, tier],
  );
}
