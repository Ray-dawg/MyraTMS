import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);
  const minLoadsParam = Number(req.nextUrl.searchParams.get('min_loads') ?? '0');
  const minLoads = Number.isInteger(minLoadsParam) && minLoadsParam >= 0 ? minLoadsParam : 0;

  try {
    const r = await db.query(
      `SELECT DISTINCT ON (s.carrier_registry_id)
              s.carrier_registry_id, cr.legal_name, cr.mc_number,
              s.score, s.total_loads_observed, s.on_time_pct, s.acceptance_rate,
              s.cancellation_rate, s.claims_count, s.open_risk_signals, s.computed_at
         FROM myra_carrier_scores s
         JOIN carrier_registry cr ON cr.id = s.carrier_registry_id
         JOIN carriers c ON c.carrier_registry_id = s.carrier_registry_id
        WHERE c.tenant_id = $1 AND s.total_loads_observed >= $2
        ORDER BY s.carrier_registry_id, s.computed_at DESC`,
      [tenantId, minLoads],
    );
    return NextResponse.json({ tenantId, minLoads, carriers: r.rows });
  } catch (err) {
    logger.error('[carriers/score-report GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load score report' }, { status: 500 });
  }
}
