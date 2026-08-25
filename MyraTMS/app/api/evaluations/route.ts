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
  const agentId = searchParams.get('agent_id');
  const decision = searchParams.get('decision');
  const since = searchParams.get('since');

  const conditions = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (agentId) {
    params.push(Number(agentId));
    conditions.push(`agent_id = $${params.length}`);
  }
  if (decision) {
    params.push(decision);
    conditions.push(`decision = $${params.length}`);
  }
  if (since) {
    params.push(since);
    conditions.push(`evaluated_at >= $${params.length}`);
  }

  try {
    const r = await db.query(
      `SELECT id, envelope_id, agent_id, tenant_id, pipeline_load_id, action, context,
              autonomy_level_applied, decision, reason, shadow_mode, source_event_id,
              evaluated_at, correlation_id
         FROM authority_evaluations
        WHERE ${conditions.join(' AND ')}
        ORDER BY evaluated_at DESC
        LIMIT 200`,
      params,
    );
    return NextResponse.json({ evaluations: r.rows });
  } catch (err) {
    logger.error('[evaluations GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load evaluations' }, { status: 500 });
  }
}
