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

  try {
    const r = await db.query(
      `SELECT score, formula_version, on_time_pct, acceptance_rate, cancellation_rate,
              claims_count, open_risk_signals, total_loads_observed, computed_at
         FROM myra_carrier_scores
        WHERE carrier_registry_id = $1
        ORDER BY computed_at DESC
        LIMIT 1`,
      [registryId],
    );
    if (r.rows.length === 0) {
      return NextResponse.json({ error: 'No score computed yet for this carrier' }, { status: 404 });
    }
    return NextResponse.json({ score: r.rows[0] });
  } catch (err) {
    logger.error('[carriers/registry/:id/score GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load carrier score' }, { status: 500 });
  }
}
