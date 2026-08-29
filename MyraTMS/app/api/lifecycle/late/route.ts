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

  try {
    const { rows } = await db.query(
      `SELECT pipeline_load_id, pickup_date, delivery_date, stage, late_status, time_overdue
         FROM v_lifecycle_late_loads
        WHERE tenant_id = $1 AND late_status IS NOT NULL
        ORDER BY time_overdue DESC`,
      [tenantId],
    );
    return NextResponse.json({ tenantId, lateLoads: rows });
  } catch (err) {
    logger.error('[lifecycle/late GET] failed', err);
    return NextResponse.json({ error: 'Failed to load late-load report' }, { status: 500 });
  }
}
