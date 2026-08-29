import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ pipelineLoadId: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { pipelineLoadId: raw } = await params;
  const pipelineLoadId = Number(raw);
  if (!Number.isInteger(pipelineLoadId)) {
    return NextResponse.json({ error: 'Invalid pipelineLoadId' }, { status: 400 });
  }

  // events.tenant_id exists and is populated (T-17/T-19) — scope the
  // timeline to the caller's tenant (or the explicit ?tenant_id= a
  // super-admin may pass) rather than trusting pipelineLoadId alone, which
  // is a guessable/enumerable SERIAL id.
  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);

  try {
    const { rows } = await db.query(
      `SELECT event_type, entity_type, source, actor_type, payload, stage_from, stage_to, occurred_at
         FROM events WHERE pipeline_load_id = $1 AND tenant_id = $2 ORDER BY occurred_at ASC`,
      [pipelineLoadId, tenantId],
    );
    return NextResponse.json({ pipelineLoadId, events: rows });
  } catch (err) {
    logger.error('[lifecycle/load GET] failed', err);
    return NextResponse.json({ error: 'Failed to load lifecycle timeline' }, { status: 500 });
  }
}
