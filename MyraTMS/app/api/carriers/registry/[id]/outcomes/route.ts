import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { id } = await params;
  const registryId = Number(id);
  if (!Number.isInteger(registryId)) {
    return NextResponse.json({ error: 'Invalid registry id' }, { status: 400 });
  }

  const limitParam = Number(req.nextUrl.searchParams.get('limit') ?? '50');
  const limit = Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 500 ? limitParam : 50;

  try {
    const r = await db.query(
      `SELECT event_type, occurred_at, pipeline_load_id, derived_from_table, derived_from_id, payload
         FROM carrier_outcome_events
        WHERE carrier_registry_id = $1
        ORDER BY occurred_at DESC
        LIMIT $2`,
      [registryId, limit],
    );
    return NextResponse.json({ outcomes: r.rows });
  } catch (err) {
    logger.error('[carriers/registry/:id/outcomes GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load carrier outcomes' }, { status: 500 });
  }
}
