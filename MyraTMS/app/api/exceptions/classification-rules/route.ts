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
      `SELECT id, source_module, condition, severity, sla_minutes, suggested_action, is_active, version
         FROM exception_classification_rules WHERE tenant_id = $1 ORDER BY source_module, version`,
      [tenantId],
    );
    return NextResponse.json({ tenantId, rules: rows });
  } catch (err) {
    logger.error('[exceptions/classification-rules GET] failed', err);
    return NextResponse.json({ error: 'Failed to load classification rules' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { sourceModule, condition, severity, slaMinutes, suggestedAction } = body ?? {};
  if (!sourceModule || !severity || !Number.isInteger(slaMinutes) || !suggestedAction) {
    return NextResponse.json(
      { error: 'sourceModule, severity, slaMinutes (integer), and suggestedAction are required' },
      { status: 400 },
    );
  }

  // Cross-tenant write requires super-admin, same discipline as T-23's
  // dispatch-routing IDOR fix — a non-super-admin's own tenantId is the
  // only value they may write to, regardless of what body.tenantId says.
  const tenantId = auth.user.isSuperAdmin && body.tenantId ? Number(body.tenantId) : auth.user.tenantId;

  try {
    const maxRes = await db.query<{ max: number | null }>(
      `SELECT MAX(version) AS max FROM exception_classification_rules WHERE tenant_id = $1 AND source_module = $2`,
      [tenantId, sourceModule],
    );
    const nextVersion = (maxRes.rows[0]?.max ?? 0) + 1;

    const { rows } = await db.query(
      `INSERT INTO exception_classification_rules
         (tenant_id, source_module, condition, severity, sla_minutes, suggested_action, version, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING id, version`,
      [tenantId, sourceModule, JSON.stringify(condition ?? {}), severity, slaMinutes, suggestedAction, nextVersion],
    );
    return NextResponse.json({ id: rows[0].id, version: rows[0].version });
  } catch (err) {
    logger.error('[exceptions/classification-rules POST] failed', err);
    return NextResponse.json({ error: 'Failed to create classification rule version' }, { status: 500 });
  }
}
