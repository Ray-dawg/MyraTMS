import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const since = req.nextUrl.searchParams.get('since');
  const sinceDate = since ? new Date(since) : new Date(0);
  if (Number.isNaN(sinceDate.getTime())) {
    return NextResponse.json({ error: 'Invalid since date' }, { status: 400 });
  }

  try {
    const r = await db.query<{ output_envelope: any; input_params: any; pipeline_load_id: number | null; computed_at: string }>(
      `SELECT pipeline_load_id, input_params, output_envelope, computed_at
         FROM pricing_engine_requests
        WHERE request_source = 'shadow_comparison' AND computed_at >= $1
        ORDER BY computed_at DESC`,
      [sinceDate.toISOString()],
    );
    return NextResponse.json({
      since: sinceDate.toISOString(),
      comparisons: r.rows.length,
      records: r.rows,
    });
  } catch (err) {
    logger.error('[pricing/shadow-parity-report GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load shadow parity report' }, { status: 500 });
  }
}
