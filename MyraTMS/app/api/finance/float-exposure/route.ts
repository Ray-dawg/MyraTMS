// app/api/finance/float-exposure/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';
import { getFloatExposure } from '@/lib/finance/float-governor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);
  try {
    const exposure = await getFloatExposure(tenantId);
    return NextResponse.json(exposure);
  } catch (err) {
    logger.error('[finance/float-exposure GET] failed', err);
    return NextResponse.json({ error: 'Failed to load float exposure' }, { status: 500 });
  }
}
