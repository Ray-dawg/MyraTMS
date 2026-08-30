// app/api/finance/factoring/submit/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { submitToEcapitalSandbox, recordFactoringSubmission } from '@/lib/finance/adapters/ecapital';
import { syncInvoiceFactoringStatus } from '@/lib/finance/factoring-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const body = await req.json().catch(() => null);
  const pipelineLoadId = Number(body?.pipelineLoadId);
  const feePct = Number(body?.feePct);
  if (!Number.isInteger(pipelineLoadId) || !Number.isFinite(feePct)) {
    return NextResponse.json({ error: 'Invalid pipelineLoadId or feePct' }, { status: 400 });
  }

  try {
    const result = submitToEcapitalSandbox(feePct);
    const id = await recordFactoringSubmission(pipelineLoadId, result);
    await syncInvoiceFactoringStatus(pipelineLoadId, result.status);
    return NextResponse.json({ id, ...result });
  } catch (err) {
    logger.error('[finance/factoring/submit POST] failed', err);
    return NextResponse.json({ error: 'Failed to submit factoring request' }, { status: 500 });
  }
}
