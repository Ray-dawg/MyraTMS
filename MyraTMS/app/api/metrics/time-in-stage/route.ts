import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeEventsRequest, resolveTenantId } from '@/lib/pipeline/events-api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TimeInStageRow {
  pipeline_load_id: number;
  stage: string;
  occurred_at: string;
  time_in_stage: string | null;
}

export async function GET(req: NextRequest) {
  const auth = authorizeEventsRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { searchParams } = req.nextUrl;
  const tenantId = resolveTenantId(searchParams, user);
  const stage = searchParams.get('stage');

  const conditions = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (stage) {
    params.push(stage);
    conditions.push(`stage = $${params.length}`);
  }

  try {
    const r = await db.query<TimeInStageRow>(
      `SELECT pipeline_load_id, stage, occurred_at, time_in_stage
         FROM v_time_in_stage
        WHERE ${conditions.join(' AND ')}
        ORDER BY occurred_at DESC
        LIMIT 500`,
      params,
    );
    return NextResponse.json({ tenant_id: tenantId, rows: r.rows });
  } catch (err) {
    logger.error('[metrics/time-in-stage GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load time-in-stage metrics' }, { status: 500 });
  }
}
