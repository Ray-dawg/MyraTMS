import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { computeCarrierRiskSeverity } from '@/lib/risk/carrier-risk-scoring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ carrierRegistryId: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { carrierRegistryId: raw } = await params;
  const carrierRegistryId = Number(raw);
  if (!Number.isInteger(carrierRegistryId)) {
    return NextResponse.json({ error: 'Invalid carrierRegistryId' }, { status: 400 });
  }

  try {
    const { rows } = await db.query<{ id: number; signal_type: string; severity: string; detected_at: string }>(
      `SELECT id, signal_type, severity, detected_at FROM carrier_risk_signals
        WHERE carrier_registry_id = $1 ORDER BY detected_at DESC`,
      [carrierRegistryId],
    );
    const signals = rows.map((r) => ({ ...r, computedSeverity: computeCarrierRiskSeverity(r.signal_type) }));
    return NextResponse.json({ carrierRegistryId, signals });
  } catch (err) {
    logger.error('[risk/carrier GET] failed', err);
    return NextResponse.json({ error: 'Failed to load carrier risk signals' }, { status: 500 });
  }
}
