import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest, resolveTenantId } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const status = req.nextUrl.searchParams.get('status') ?? 'unresolved';
  const allowedStatuses = ['match', 'mismatch', 'unparseable', 'not_checked'];
  const resolvedStatus = status === 'unresolved' ? 'mismatch' : status;
  if (!allowedStatuses.includes(resolvedStatus)) {
    return NextResponse.json({ error: 'Invalid status filter' }, { status: 400 });
  }
  const tenantId = resolveTenantId(req.nextUrl.searchParams, auth.user);

  try {
    const { rows } = await db.query(
      `SELECT id, name, type, related_to, terms_match_status, parsed_terms, created_at
         FROM documents WHERE terms_match_status = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
      [resolvedStatus, tenantId],
    );
    return NextResponse.json({ mismatches: rows });
  } catch (err) {
    logger.error('[documents/terms-mismatches GET] failed', err);
    return NextResponse.json({ error: 'Failed to load terms mismatches' }, { status: 500 });
  }
}
