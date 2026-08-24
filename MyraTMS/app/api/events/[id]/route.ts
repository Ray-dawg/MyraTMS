import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeEventsRequest, resolveTenantId } from '@/lib/pipeline/events-api-helpers';
import type { EventRow } from '@/lib/pipeline/events-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = authorizeEventsRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const tenantId = resolveTenantId(req.nextUrl.searchParams, user);

  try {
    const r = await db.query<EventRow>(
      `SELECT id, tenant_id, event_type, entity_type, entity_id, pipeline_load_id,
              source, actor_type, payload, stage_from, stage_to,
              occurred_at, recorded_at, derived_from_table, derived_from_id, correlation_id
         FROM events WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    if (r.rows.length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ event: r.rows[0] });
  } catch (err) {
    logger.error('[events/:id GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load event' }, { status: 500 });
  }
}
