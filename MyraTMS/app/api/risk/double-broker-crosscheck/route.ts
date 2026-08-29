import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { runDoubleBrokerCrossCheck } from '@/lib/risk/double-broker-crosscheck';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const sinceDays = Number(req.nextUrl.searchParams.get('since') ?? '90');

  try {
    const result = await runDoubleBrokerCrossCheck(sinceDays);
    return NextResponse.json(result);
  } catch (err) {
    logger.error('[risk/double-broker-crosscheck GET] failed', err);
    return NextResponse.json({ error: 'Failed to run cross-check' }, { status: 500 });
  }
}
