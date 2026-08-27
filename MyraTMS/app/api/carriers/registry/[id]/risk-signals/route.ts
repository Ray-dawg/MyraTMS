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
      `SELECT id, signal_type, severity, detected_at, detail, reviewed
         FROM carrier_risk_signals
        WHERE carrier_registry_id = $1
        ORDER BY detected_at DESC`,
      [registryId],
    );
    return NextResponse.json({ riskSignals: r.rows });
  } catch (err) {
    logger.error('[carriers/registry/:id/risk-signals GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load carrier risk signals' }, { status: 500 });
  }
}
