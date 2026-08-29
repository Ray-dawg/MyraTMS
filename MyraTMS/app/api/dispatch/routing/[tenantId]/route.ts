import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';
import { resolveDispatchRouting, setDispatchRoutingOverride, type DispatchMode } from '@/lib/dispatch/routing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseTenantId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { tenantId: raw } = await params;
  const tenantId = parseTenantId(raw);
  if (tenantId === null) return NextResponse.json({ error: 'Invalid tenantId' }, { status: 400 });

  try {
    const resolution = await resolveDispatchRouting(tenantId);
    return NextResponse.json(resolution);
  } catch (err) {
    logger.error('[dispatch/routing GET] failed', err);
    return NextResponse.json({ error: 'Failed to resolve dispatch routing' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { tenantId: raw } = await params;
  const tenantId = parseTenantId(raw);
  if (tenantId === null) return NextResponse.json({ error: 'Invalid tenantId' }, { status: 400 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const mode: DispatchMode = body?.mode;
  if (!['myra_managed', 'in_house_notify'].includes(mode)) {
    return NextResponse.json({ error: "mode must be 'myra_managed' or 'in_house_notify'" }, { status: 400 });
  }

  try {
    await setDispatchRoutingOverride(tenantId, mode, body?.notifyContact ?? null);
    const resolution = await resolveDispatchRouting(tenantId);
    return NextResponse.json(resolution);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to set dispatch routing override';
    logger.error('[dispatch/routing POST] failed', err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
