import { db } from '@/lib/pipeline/db-adapter';

/**
 * Resolves Myra's tenant id by slug, mirroring fn_myra_tenant_id() at the SQL
 * level (migration 035). Every live call path that needs "the Myra tenant"
 * must go through this rather than hardcoding an id — tenant id=1 is the
 * `_system` tenant, not Myra; see wave1.md for the production bug this
 * caused in T-17/T-18 before T-19 fixed it.
 */
export async function getMyraTenantId(): Promise<number> {
  const r = await db.query<{ id: number }>(`SELECT id FROM tenants WHERE slug = 'myra'`);
  if (r.rows.length === 0) {
    throw new Error(`getMyraTenantId: no tenants row with slug='myra'`);
  }
  return r.rows[0].id;
}
