import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeEventsRequest, resolveTenantId, clampLimit } from '@/lib/pipeline/events-api-helpers';
import type { EventRow } from '@/lib/pipeline/events-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeEventsRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { searchParams } = req.nextUrl;
  const tenantId = resolveTenantId(searchParams, user);
  const entityType = searchParams.get('entity_type');
  const pipelineLoadId = searchParams.get('pipeline_load_id');
  const since = searchParams.get('since');
  const until = searchParams.get('until');
  const limit = clampLimit(searchParams.get('limit'));

  const conditions = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];

  if (entityType) {
    params.push(entityType);
    conditions.push(`entity_type = $${params.length}`);
  }
  if (pipelineLoadId) {
    params.push(Number(pipelineLoadId));
    conditions.push(`pipeline_load_id = $${params.length}`);
  }
  if (since) {
    params.push(since);
    conditions.push(`occurred_at >= $${params.length}`);
  }
  if (until) {
    params.push(until);
    conditions.push(`occurred_at <= $${params.length}`);
  }
  params.push(limit);

  try {
    const r = await db.query<EventRow>(
      `SELECT id, tenant_id, event_type, entity_type, entity_id, pipeline_load_id,
              source, actor_type, payload, stage_from, stage_to,
              occurred_at, recorded_at, derived_from_table, derived_from_id, correlation_id
         FROM events
        WHERE ${conditions.join(' AND ')}
        ORDER BY occurred_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return NextResponse.json({ events: r.rows });
  } catch (err) {
    logger.error('[events GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load events' }, { status: 500 });
  }
}
