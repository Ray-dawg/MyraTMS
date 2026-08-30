// app/api/finance/quickpay/disburse/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { disburseQuickPaySandbox, recordQuickPayDisbursement } from '@/lib/finance/adapters/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const body = await req.json().catch(() => null);
  const pipelineLoadId = Number(body?.pipelineLoadId);
  const carrierRegistryId = Number(body?.carrierRegistryId);
  const amount = Number(body?.amount);
  const discountPct = Number(body?.discountPct);
  if (![pipelineLoadId, carrierRegistryId, amount, discountPct].every(Number.isFinite)) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  }

  try {
    const result = disburseQuickPaySandbox(amount, discountPct);
    const id = await recordQuickPayDisbursement(pipelineLoadId, carrierRegistryId, amount, result);
    return NextResponse.json({ id, ...result });
  } catch (err) {
    logger.error('[finance/quickpay/disburse POST] failed', err);
    return NextResponse.json({ error: 'Failed to disburse quick pay' }, { status: 500 });
  }
}
