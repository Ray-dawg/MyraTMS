import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeEventsRequest, resolveTenantId } from '@/lib/pipeline/events-api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CostPerCallRow {
  calls_total: number;
  calls_with_cost_data: number;
  avg_cost_per_call_dollars: number | null;
}

export async function GET(req: NextRequest) {
  const auth = authorizeEventsRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const tenantId = resolveTenantId(req.nextUrl.searchParams, user);

  try {
    const r = await db.query<CostPerCallRow>(
      `SELECT calls_total, calls_with_cost_data, avg_cost_per_call_dollars
         FROM v_cost_per_call WHERE tenant_id = $1`,
      [tenantId],
    );
    const row = r.rows[0] ?? { calls_total: 0, calls_with_cost_data: 0, avg_cost_per_call_dollars: null };
    return NextResponse.json({
      tenant_id: tenantId,
      ...row,
      note:
        row.calls_with_cost_data === 0
          ? 'not_yet_tracked: cost columns exist but no worker populates them yet'
          : undefined,
    });
  } catch (err) {
    logger.error('[metrics/cost-per-call GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load cost-per-call metrics' }, { status: 500 });
  }
}
