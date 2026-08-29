// app/api/exceptions/sla-breaches/route.ts
//
// SLA tracking for the *new* bridged sources only — the existing 8 TMS
// rules don't currently carry an SLA concept (spec §6).
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);

  try {
    const { rows } = await db.query(
      `SELECT id, type, severity, title, source_module, sla_due_at, created_at
         FROM exceptions
        WHERE tenant_id = $1 AND status = 'active' AND sla_due_at IS NOT NULL AND sla_due_at < NOW()
        ORDER BY sla_due_at ASC`,
      [tenantId],
    );
    return NextResponse.json({ tenantId, breaches: rows });
  } catch (err) {
    logger.error('[exceptions/sla-breaches GET] failed', err);
    return NextResponse.json({ error: 'Failed to load SLA breaches' }, { status: 500 });
  }
}
