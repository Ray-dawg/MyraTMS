import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { searchParams } = req.nextUrl;
  const tenantId = resolveTenantId(searchParams, user);
  const status = searchParams.get('status') ?? 'pending';

  try {
    const r = await db.query(
      `SELECT id, evaluation_id, tenant_id, pipeline_load_id, severity, status,
              assigned_to, resolution_note, created_at, resolved_at
         FROM escalations
        WHERE tenant_id = $1 AND status = $2
        ORDER BY created_at DESC
        LIMIT 200`,
      [tenantId, status],
    );
    return NextResponse.json({ escalations: r.rows });
  } catch (err) {
    logger.error('[escalations GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load escalations' }, { status: 500 });
  }
}
