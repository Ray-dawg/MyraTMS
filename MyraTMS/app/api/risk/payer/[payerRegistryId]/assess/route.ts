import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_LEVELS = ['unknown', 'weak', 'acceptable', 'strong'];

export async function POST(req: NextRequest, { params }: { params: Promise<{ payerRegistryId: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { payerRegistryId: raw } = await params;
  const payerRegistryId = Number(raw);
  if (!Number.isInteger(payerRegistryId)) {
    return NextResponse.json({ error: 'Invalid payerRegistryId' }, { status: 400 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { creditLevel, assessmentSource, assessmentNotes } = body ?? {};
  if (!VALID_LEVELS.includes(creditLevel) || !assessmentSource) {
    return NextResponse.json({ error: 'creditLevel (unknown|weak|acceptable|strong) and assessmentSource are required' }, { status: 400 });
  }

  const assessedBy = `${auth.user.firstName ?? ''} ${auth.user.lastName ?? ''}`.trim() || auth.user.userId;

  try {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO payer_credit_assessments (payer_registry_id, credit_level, assessment_source, assessment_notes, assessed_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [payerRegistryId, creditLevel, assessmentSource, assessmentNotes ?? null, assessedBy],
    );
    return NextResponse.json({ id: rows[0].id, payerRegistryId, creditLevel, assessedBy });
  } catch (err) {
    logger.error('[risk/payer/assess POST] failed', err);
    return NextResponse.json({ error: 'Failed to record credit assessment' }, { status: 500 });
  }
}
