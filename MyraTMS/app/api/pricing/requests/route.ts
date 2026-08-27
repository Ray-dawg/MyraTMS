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
  const direction = req.nextUrl.searchParams.get('direction');
  const since = req.nextUrl.searchParams.get('since');

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];

  if (direction && ['sell', 'buy'].includes(direction)) {
    params.push(direction);
    conditions.push(`direction = $${params.length}`);
  }
  if (since) {
    const sinceDate = new Date(since);
    if (Number.isNaN(sinceDate.getTime())) {
      return NextResponse.json({ error: 'Invalid since date' }, { status: 400 });
    }
    params.push(sinceDate.toISOString());
    conditions.push(`computed_at >= $${params.length}`);
  }

  try {
    const r = await db.query(
      `SELECT id, pipeline_load_id, direction, request_source, input_params, output_envelope,
              margin_source_used, computed_at
         FROM pricing_engine_requests
        WHERE ${conditions.join(' AND ')}
        ORDER BY computed_at DESC
        LIMIT 200`,
      params,
    );
    return NextResponse.json({ requests: r.rows });
  } catch (err) {
    logger.error('[pricing/requests GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load pricing requests' }, { status: 500 });
  }
}
