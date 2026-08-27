import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { quotePricing, type PricingQuoteRequest } from '@/lib/pricing/pricing-engine';

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
  if (!body?.load) {
    return NextResponse.json({ error: 'load is required' }, { status: 400 });
  }

  const request: PricingQuoteRequest = {
    tenantId: body.tenantId ?? auth.user.tenantId,
    direction: body.direction,
    requestSource: body.requestSource ?? 'dispatch_one',
    pipelineLoadId: body.pipelineLoadId ?? undefined,
    load: body.load,
  };

  try {
    const result = await quotePricing(request);
    return NextResponse.json(result);
  } catch (err) {
    logger.error('[pricing/quote POST] failed', err);
    return NextResponse.json({ error: 'Failed to compute pricing quote' }, { status: 500 });
  }
}
