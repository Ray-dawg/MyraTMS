// app/api/finance/treasury-report/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';
import { getTreasuryReport } from '@/lib/finance/treasury-report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);
  try {
    const report = await getTreasuryReport(tenantId);
    return NextResponse.json(report);
  } catch (err) {
    logger.error('[finance/treasury-report GET] failed', err);
    return NextResponse.json({ error: 'Failed to compute treasury report' }, { status: 500 });
  }
}
