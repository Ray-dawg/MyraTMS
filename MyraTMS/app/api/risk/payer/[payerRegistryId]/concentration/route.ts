import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';
import { getConcentrationCap } from '@/lib/risk/payer-credit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ payerRegistryId: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { payerRegistryId: raw } = await params;
  const payerRegistryId = Number(raw);
  if (!Number.isInteger(payerRegistryId)) {
    return NextResponse.json({ error: 'Invalid payerRegistryId' }, { status: 400 });
  }
  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);

  try {
    const { rows } = await db.query<{ payer_registry_id: number; open_exposure: string; concentration_pct: string }>(
      `SELECT payer_registry_id, open_exposure, concentration_pct FROM v_payer_concentration_exposure
        WHERE payer_registry_id = $1 AND tenant_id = $2`,
      [payerRegistryId, tenantId],
    );
    const cap = await getConcentrationCap(tenantId);
    const row = rows[0];
    return NextResponse.json({
      payerRegistryId,
      openExposure: row ? Number(row.open_exposure) : 0,
      concentrationPct: row ? Number(row.concentration_pct) : 0,
      capPct: cap,
      overCap: row ? Number(row.concentration_pct) * 100 > cap : false,
    });
  } catch (err) {
    logger.error('[risk/payer/concentration GET] failed', err);
    return NextResponse.json({ error: 'Failed to load concentration exposure' }, { status: 500 });
  }
}
