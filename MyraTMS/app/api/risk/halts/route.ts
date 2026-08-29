import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const status = req.nextUrl.searchParams.get('status') ?? 'active';
  const whereClause = status === 'active' ? 'WHERE resumed_at IS NULL' : '';

  try {
    const { rows } = await db.query(
      `SELECT id, pipeline_load_id, halt_reason, halt_detail, halted_at, halted_by, resumed_at, resumed_by, resolution_note
         FROM transaction_halts ${whereClause} ORDER BY halted_at DESC`,
    );
    return NextResponse.json({ halts: rows });
  } catch (err) {
    logger.error('[risk/halts GET] failed', err);
    return NextResponse.json({ error: 'Failed to load transaction halts' }, { status: 500 });
  }
}
