import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { compileEnvelope } from '@/lib/negotiation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body?.direction || !['sell', 'buy'].includes(body.direction)) {
    return NextResponse.json({ error: "direction must be 'sell' or 'buy'" }, { status: 400 });
  }
  if (body?.pipelineLoadId == null) {
    return NextResponse.json({ error: 'pipelineLoadId is required' }, { status: 400 });
  }

  try {
    const brief = await compileEnvelope({
      tenantId: body.tenantId ?? auth.user.tenantId,
      direction: body.direction,
      pipelineLoadId: body.pipelineLoadId,
      counterpartyId: body.counterpartyId ?? 0,
    });
    return NextResponse.json(brief);
  } catch (err) {
    logger.error('[negotiation/envelope POST] failed', err);
    return NextResponse.json({ error: 'Failed to compile negotiation envelope' }, { status: 500 });
  }
}
