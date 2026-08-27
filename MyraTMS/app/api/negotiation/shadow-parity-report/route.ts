import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { db } from '@/lib/pipeline/db-adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Sell side only (spec §6) -- buy side has no real-history comparison to
// report yet (Task 11's harness output is a console report, not persisted
// rows, since it runs against synthetic cases, not real pipeline_loads).
export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const since = req.nextUrl.searchParams.get('since') ?? '1970-01-01';

  try {
    const { rows } = await db.query(
      `SELECT id, pipeline_load_id, output_envelope, computed_at
         FROM pricing_engine_requests
        WHERE tenant_id = $2 AND direction = 'sell' AND request_source = 'shadow_comparison' AND computed_at >= $1
        ORDER BY computed_at DESC`,
      [since, auth.user.tenantId],
    );
    return NextResponse.json({ comparisons: rows });
  } catch (err) {
    logger.error('[negotiation/shadow-parity-report GET] failed', err);
    return NextResponse.json({ error: 'Failed to fetch shadow-parity report' }, { status: 500 });
  }
}

