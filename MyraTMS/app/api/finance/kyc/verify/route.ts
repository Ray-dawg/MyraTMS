// app/api/finance/kyc/verify/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { verifyKycSandbox, recordKycVerification } from '@/lib/finance/adapters/persona';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const body = await req.json().catch(() => null);
  const entityType = body?.entityType;
  const entityId = Number(body?.entityId);
  if ((entityType !== 'carrier' && entityType !== 'payer') || !Number.isInteger(entityId)) {
    return NextResponse.json({ error: 'Invalid entityType or entityId' }, { status: 400 });
  }

  try {
    const result = verifyKycSandbox();
    const id = await recordKycVerification(entityType, entityId, result);
    return NextResponse.json({ id, ...result });
  } catch (err) {
    logger.error('[finance/kyc/verify POST] failed', err);
    return NextResponse.json({ error: 'Failed to verify KYC' }, { status: 500 });
  }
}
