import { db } from '@/lib/pipeline/db-adapter';

/**
 * The margin floor that decides auto_book_eligible (T-19). Single source of
 * truth in tenant_config's margin_floor_cad/margin_floor_usd keys — replaces
 * the three independent hardcoded `currency === 'CAD' ? 270 : 200` literals
 * that used to live in compiler-worker.ts, qualifier-worker.ts, and
 * researcher-worker.ts. Currently resolves to Myra's tenant row only
 * (fn_myra_tenant_id() at the SQL level, mirrored here) — becomes genuinely
 * per-tenant once T-19b wires this into a tenant-scoped call path.
 */
export async function getMarginFloor(currency: 'CAD' | 'USD'): Promise<number> {
  const key = currency === 'CAD' ? 'margin_floor_cad' : 'margin_floor_usd';
  const r = await db.query<{ value: string }>(
    `SELECT value FROM tenant_config
      WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'myra') AND key = $1`,
    [key],
  );
  if (r.rows.length === 0) {
    throw new Error(`getMarginFloor: no tenant_config row for key '${key}' on the Myra tenant`);
  }
  return Number(r.rows[0].value);
}
