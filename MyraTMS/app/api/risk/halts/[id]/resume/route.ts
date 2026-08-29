import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/pipeline/db-adapter';
import { logger } from '@/lib/logger';
import { authorizeGovernanceRequest } from '@/lib/governance/api-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = authorizeGovernanceRequest(req);
  if ('error' in auth) return auth.error;

  const { id } = await params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { actor, resolutionNote } = body ?? {};
  if (!actor || !resolutionNote) {
    return NextResponse.json({ error: 'actor and resolutionNote are required — resume is human-only' }, { status: 400 });
  }

  try {
    const { rows } = await db.query(
      `UPDATE transaction_halts SET resumed_at = NOW(), resumed_by = $1, resolution_note = $2
        WHERE id = $3 AND resumed_at IS NULL RETURNING *`,
      [actor, resolutionNote, id],
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: 'Halt not found or already resumed' }, { status: 404 });
    }
    return NextResponse.json(rows[0]);
  } catch (err) {
    logger.error('[risk/halts/resume POST] failed', err);
    return NextResponse.json({ error: 'Failed to resume halt' }, { status: 500 });
  }
}
