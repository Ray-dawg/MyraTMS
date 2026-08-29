// app/api/documents/rate-con/[pipelineLoadId]/route.ts
//
// Unified status per spec §5: outbound events (document.rate_con_sent) for
// buy-side, inbound events (document.rate_con_received/matched) for
// sell-side, same pipeline_load_id.
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
  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);

  try {
    const { rows } = await db.query(
      `SELECT event_type, occurred_at, payload FROM events
        WHERE pipeline_load_id = $1 AND tenant_id = $2
          AND event_type IN ('document.rate_con_sent', 'document.rate_con_received', 'document.rate_con_matched', 'document.terms_mismatch_detected')
        ORDER BY occurred_at ASC`,
      [pipelineLoadId, tenantId],
    );
    return NextResponse.json({ pipelineLoadId, events: rows });
  } catch (err) {
    logger.error('[documents/rate-con GET] failed', err);
    return NextResponse.json({ error: 'Failed to load rate-con status' }, { status: 500 });
  }
}
