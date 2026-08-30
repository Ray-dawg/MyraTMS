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
 *  guessed. */
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

  const { rows } = await q.query<{ id: number }>(
    `INSERT INTO tenant_policies (tenant_id, version, load_source_policy, dispatch_agent_enabled, negotiation_directions, created_by)
     VALUES ($1, 1, $2, $3, $4, 'system:t28-provision')
     RETURNING id`,
    [tenantId, template.load_source_policy, dispatchAgentEnabled, template.negotiation_directions],
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
