import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeEventsRequest, resolveTenantId } from '@/lib/pipeline/events-api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StageConversionRow {
  stage: string;
  entries: number;
  entries_7d: number;
}

export async function GET(req: NextRequest) {
  const auth = authorizeEventsRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const tenantId = resolveTenantId(req.nextUrl.searchParams, user);

  try {
    const r = await db.query<StageConversionRow>(
      `SELECT stage, entries, entries_7d FROM v_stage_conversion WHERE tenant_id = $1 ORDER BY stage`,
      [tenantId],
    );
    return NextResponse.json({ tenant_id: tenantId, stages: r.rows });
  } catch (err) {
    logger.error('[metrics/stage-conversion GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load stage conversion metrics' }, { status: 500 });
  }
}
