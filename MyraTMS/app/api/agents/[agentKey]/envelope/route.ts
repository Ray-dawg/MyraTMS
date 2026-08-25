import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';
import type { AuthorityEnvelopeRow } from '@/lib/governance/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function getAgentId(agentKey: string): Promise<number | null> {
  const r = await db.query<{ id: number }>(`SELECT id FROM agents WHERE agent_key = $1`, [agentKey]);
  return r.rows[0]?.id ?? null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ agentKey: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { agentKey } = await params;
  const tenantId = resolveTenantId(req.nextUrl.searchParams, user);

  const agentId = await getAgentId(agentKey);
  if (agentId === null) return NextResponse.json({ error: 'unknown_agent' }, { status: 404 });

  try {
    const r = await db.query<AuthorityEnvelopeRow>(
      `SELECT * FROM authority_envelopes WHERE agent_id = $1 AND tenant_id = $2 AND is_active = true`,
      [agentId, tenantId],
    );
    if (r.rows.length === 0) return NextResponse.json({ error: 'no_active_envelope' }, { status: 404 });
    return NextResponse.json({ envelope: r.rows[0] });
  } catch (err) {
    logger.error('[agents/:agentKey/envelope GET] query failed', err);
    return NextResponse.json({ error: 'Failed to load envelope' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ agentKey: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;
  const { user } = auth;

  const { agentKey } = await params;
  const agentId = await getAgentId(agentKey);
  if (agentId === null) return NextResponse.json({ error: 'unknown_agent' }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // Same gate as every other tenant-scoped write in this codebase: only a
  // super-admin may target a tenant_id other than their own, whether it
  // arrives via query string (resolveTenantId's normal path) or, here, the
  // body. A body.tenant_id from a non-super-admin is silently ignored
  // rather than trusted, so an ordinary admin/ops user can't write another
  // tenant's envelope by passing a different id in the payload.
  const bodyTenantParams = new URLSearchParams();
  if (typeof body.tenant_id === 'number') bodyTenantParams.set('tenant_id', String(body.tenant_id));
  const tenantId = resolveTenantId(bodyTenantParams, user);

  try {
    const current = await db.query<{ id: number; version: number }>(
      `SELECT id, version FROM authority_envelopes WHERE agent_id = $1 AND tenant_id = $2 AND is_active = true`,
      [agentId, tenantId],
    );
    const nextVersion = (current.rows[0]?.version ?? 0) + 1;

    if (current.rows.length > 0) {
      await db.query(`UPDATE authority_envelopes SET is_active = false WHERE id = $1`, [current.rows[0].id]);
    }

    const inserted = await db.query<{ id: number }>(
      `INSERT INTO authority_envelopes (
         agent_id, tenant_id, version, envelope_name, permissions, tools, budget, policies,
         confidence_threshold, autonomy_default, escalation_rules, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        agentId, tenantId, nextVersion,
        body.envelope_name ?? `${agentKey}-v${nextVersion}`,
        JSON.stringify(body.permissions ?? { can: [], cannot: [] }),
        JSON.stringify(body.tools ?? []),
        JSON.stringify(body.budget ?? {}),
        JSON.stringify(body.policies ?? {}),
        typeof body.confidence_threshold === 'number' ? body.confidence_threshold : 0.7,
        body.autonomy_default ?? 'L2',
        JSON.stringify(body.escalation_rules ?? []),
        user.userId,
      ],
    );

    logger.info(`[agents/:agentKey/envelope POST] new envelope v${nextVersion} for agent=${agentKey} by user=${user.userId}`);
    return NextResponse.json({ envelope_id: inserted.rows[0].id, version: nextVersion }, { status: 201 });
  } catch (err) {
    logger.error('[agents/:agentKey/envelope POST] failed', err);
    return NextResponse.json({ error: 'Failed to create envelope version' }, { status: 500 });
  }
}
