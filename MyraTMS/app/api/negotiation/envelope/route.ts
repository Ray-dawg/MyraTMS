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
  // Buy direction requires a real counterpartyId (carrier_registry.id is a
  // SERIAL PK, so 1 is the lowest valid id -- 0/null/undefined always means
  // "not provided"). Without this check a missing counterpartyId silently
  // defaulted to 0, which profileCarrier() previously turned into a
  // null-filled profile instead of an error (see Fix 3 in the T-22 fix
  // wave) -- reject it here instead of letting it reach that far.
  if (body.direction === 'buy' && !(Number(body.counterpartyId) > 0)) {
    return NextResponse.json(
      { error: 'counterpartyId is required and must be a positive carrier_registry id for direction=buy' },
      { status: 400 },
    );
  }

  try {
    const brief = await compileEnvelope({
      tenantId: auth.user.tenantId,
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
