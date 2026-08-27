import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { getObjectionPlaybook } from '@/lib/negotiation/objection-playbook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const counterpartyType = req.nextUrl.searchParams.get('counterparty_type');
  if (!counterpartyType || !['shipper', 'carrier'].includes(counterpartyType)) {
    return NextResponse.json({ error: "counterparty_type must be 'shipper' or 'carrier'" }, { status: 400 });
  }

  try {
    const entries = await getObjectionPlaybook(counterpartyType as 'shipper' | 'carrier', []);
    return NextResponse.json({ entries });
  } catch (err) {
    logger.error('[negotiation/objection-playbook GET] failed', err);
    return NextResponse.json({ error: 'Failed to fetch objection playbook' }, { status: 500 });
  }
}
